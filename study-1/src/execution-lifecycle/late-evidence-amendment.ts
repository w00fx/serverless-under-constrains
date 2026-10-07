// `late-evidence assess <package>` (BR-RUA-043, BR-RUA-044, D-16; design §8.13; AC-RUA-030): late
// evidence observed after a package was finalized is preserved in a LATE_EVIDENCE amendment, never
// in the original package, whose files and digests stay exactly as they are.
// - The stream is re-captured with the late-record capture when the execution's tables can still
//   be read (`capture` ports given), over every frozen unit of the package; otherwise it is the
//   stream the package froze at cleanup step 1. A capture that fails writes nothing: an amendment
//   that observed nothing verifiable would only hide the original assessment.
// - Monitoring is the one the original assessment declares (its outcome and window): an amendment
//   reassesses what was observed late, it cannot complete a window the original never completed.
// - The assessment is `assessPackageLateEvidence` over the original files, so every frozen trial
//   or the frozen probe result is re-derived exactly as at cleanup step 2; its evidence refs then
//   name the payload copy of the stream. The payload is `payload/late-evidence-stream.jsonl` and
//   `payload/late-evidence-assessment.json`, written through `writeAmendmentPackage`.

import type { LateCapturePorts } from '../evidence-collection/late-record-capture.ts';
import { captureLateRecords } from '../evidence-collection/late-record-capture.ts';
import type { RawArtifact } from '../evidence-ingestion/ingestion-model.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { AMENDMENT_PATHS, EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { readRecordFile } from '../study-comparison/record-files.ts';
import type { LateMonitoring } from '../trial-oracle/late-evidence/late-evidence-input.ts';
import { writeAmendmentPackage } from './amendment-writer.ts';
import { ExecutionPackage, filesByPath } from './execution-package.ts';
import type { AdmittedExecution, ExecutionServices, ExecutionTargets } from './execution-ports.ts';
import { executionTargetsOf } from './execution-targets.ts';
import { lateCapturePlan } from './late-capture-plan.ts';
import { assessPackageLateEvidence } from './package-late-evidence.ts';

/** What the service reads and writes through. */
export interface LateEvidenceAmendmentDeps {
  readonly files: PackageFileSystem;
  readonly services: ExecutionServices;
  /** The late-capture readers while the execution's tables exist; absent to reassess the packaged stream. */
  readonly capture?: Omit<LateCapturePorts, 'clock'>;
}

/** Where the amended stream came from. */
export type LateStreamSource = 'capture' | 'packaged_stream';

/** The amendment the service wrote. */
export interface LateEvidenceAmendment {
  readonly amendment_directory: string;
  readonly assessment: LateEvidenceAssessment;
  readonly source: LateStreamSource;
}

type PackageFiles = ReadonlyMap<string, Uint8Array>;

const SUBJECT = 'BR-RUA-043';

/**
 * Reassesses a finalized package's late evidence into a LATE_EVIDENCE amendment, or every reason
 * it cannot.
 *
 * @example
 * const amended = await assessLateEvidenceAmendment(admitted, { files, services, capture: { store, dlq, durable } });
 * if (amended.ok) amended.value.assessment.late_evidence_status; // 'consistent' after late, agreeing records
 */
export async function assessLateEvidenceAmendment(
  admitted: AdmittedExecution,
  deps: LateEvidenceAmendmentDeps,
): Promise<Result<LateEvidenceAmendment, readonly StructuredReason[]>> {
  const { services } = deps;
  const snapshot = await new ExecutionPackage(deps.files, admitted.identity, admitted.package_directory).snapshot();
  if (!snapshot.ok) {
    return err([snapshot.error]);
  }
  const files = filesByPath(snapshot.value);
  const index = files.get(EXECUTION_PATHS.packageIndex);
  const monitoring = originalMonitoring(files, services);
  if (index === undefined) {
    return err([
      amendmentReason(
        'PACKAGE_NOT_FINALIZED',
        `${admitted.package_directory} has no package-index.json; expected a finalized package`,
      ),
    ]);
  }
  if (!monitoring.ok) {
    return monitoring;
  }
  const stream = await lateStream(files, admitted, deps);
  if (!stream.ok) {
    return stream;
  }
  const assessment = assessPackageLateEvidence(
    {
      files: snapshot.value,
      admitted,
      monitoring: monitoring.value,
      stream: { path: EXECUTION_PATHS.lateEvidenceStream, bytes: stream.value.bytes },
      assessed_at: formatUtcMillis(services.clock.now()),
    },
    services.validator,
  );
  if (!assessment.ok) {
    return assessment;
  }
  const amended = citingPayloadStream(assessment.value);
  const written = await writeAmendmentPackage(deps.files, services, {
    admitted,
    kind: 'LATE_EVIDENCE',
    original_index_sha256: sha256Hex(index),
    payload: [
      { path: AMENDMENT_PATHS.lateEvidenceStream, bytes: stream.value.bytes },
      { path: AMENDMENT_PATHS.lateEvidenceAssessment, bytes: serializeRecordFile(amended) },
    ],
    subject: SUBJECT,
  });
  return written.ok
    ? ok({ amendment_directory: written.value, assessment: amended, source: stream.value.source })
    : written;
}

/**
 * The monitoring a late-evidence assessment declares, as the oracle reads it.
 *
 * @example
 * monitoringOf(assessment); // { outcome: 'complete', started_at, ended_at }
 */
export function monitoringOf(assessment: LateEvidenceAssessment): LateMonitoring {
  const started = assessment.monitoring_started_at;
  const ended = assessment.monitoring_ended_at;
  if (assessment.monitoring === 'skipped') {
    return { outcome: 'skipped' };
  }
  if (assessment.monitoring === 'complete' && started !== undefined && ended !== undefined) {
    return { outcome: 'complete', started_at: started, ended_at: ended };
  }
  // A complete window without both instants is not a complete window.
  const outcome = assessment.monitoring === 'complete' ? 'failed' : assessment.monitoring;
  return {
    outcome,
    ...(started === undefined ? {} : { started_at: started }),
    ...(ended === undefined ? {} : { ended_at: ended }),
  };
}

function originalMonitoring(
  files: PackageFiles,
  services: ExecutionServices,
): Result<LateMonitoring, readonly StructuredReason[]> {
  const original = readRecordFile(files, EXECUTION_PATHS.lateEvidenceAssessment, 'late_evidence_assessment', {
    validator: services.validator,
    digest: sha256Hex,
  });
  if (original.status !== 'read') {
    return err([
      amendmentReason(
        'ORIGINAL_ASSESSMENT_UNREADABLE',
        `${EXECUTION_PATHS.lateEvidenceAssessment} is ${original.status}; expected the original assessment that declares how monitoring ended`,
      ),
    ]);
  }
  return ok(monitoringOf(original.frozen.record));
}

async function lateStream(
  files: PackageFiles,
  admitted: AdmittedExecution,
  deps: LateEvidenceAmendmentDeps,
): Promise<Result<RawArtifact & { readonly source: LateStreamSource }, readonly StructuredReason[]>> {
  if (deps.capture === undefined) {
    const packaged = files.get(EXECUTION_PATHS.lateEvidenceStream);
    return packaged === undefined
      ? err([
          amendmentReason(
            'LATE_STREAM_ABSENT',
            `${EXECUTION_PATHS.lateEvidenceStream} is absent and no capture readers were given; expected a stream to reassess`,
          ),
        ])
      : ok({ path: EXECUTION_PATHS.lateEvidenceStream, bytes: packaged, source: 'packaged_stream' });
  }
  const captured = await captureLateRecords(
    { ...deps.capture, clock: deps.services.clock },
    lateCapturePlan(files, admitted, frozenTargets(files, deps.services)),
  );
  if (!captured.ok) {
    return err([
      ...captured.error,
      amendmentReason(
        'LATE_CAPTURE_FAILED',
        'the late-record capture did not complete; expected a complete re-read before amending',
      ),
    ]);
  }
  return ok({ path: EXECUTION_PATHS.lateEvidenceStream, bytes: captured.value.bytes, source: 'capture' });
}

// The deployed targets the frozen resource manifest names (each queued trial's DLQ), if any.
function frozenTargets(files: PackageFiles, services: ExecutionServices): ExecutionTargets | undefined {
  const manifest = readRecordFile(files, EXECUTION_PATHS.resourceManifest, 'resource_manifest', {
    validator: services.validator,
    digest: sha256Hex,
  });
  const targets = manifest.status === 'read' ? executionTargetsOf(manifest.frozen.record) : undefined;
  return targets?.ok === true ? targets.value : undefined;
}

// The assessment cites the stream it read; in the amendment that is the payload copy.
function citingPayloadStream(assessment: LateEvidenceAssessment): LateEvidenceAssessment {
  return {
    ...assessment,
    evidence_refs: assessment.evidence_refs.map((ref) =>
      ref.artifact_path === EXECUTION_PATHS.lateEvidenceStream
        ? { ...ref, artifact_path: AMENDMENT_PATHS.lateEvidenceStream }
        : ref,
    ),
  };
}

function amendmentReason(code: string, detail: string): StructuredReason {
  return { code, subject: SUBJECT, detail };
}
