// The late-evidence assessment of one execution package, whatever its kind (BR-RUA-043, D-16;
// AC-RUA-030): a run or a variant validation reassesses every frozen trial with the trial oracle's
// `assessLateEvidence`; a transport probe reassesses its frozen probe result (probe-late-evidence.ts).
// Both read the frozen evidence back from the package files. The runner freezes the result at
// cleanup step 2, and `late-evidence assess` freezes it into a LATE_EVIDENCE amendment. Pure.

import type { RawArtifact } from '../evidence-ingestion/ingestion-model.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { err } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../record-contract/records/group-c/late_evidence_assessment.ts';
import type { TrialExecutionIdentity } from '../record-contract/records/group-c/shared-shapes.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { TrialExecution } from '../trial-execution/trial-execution-ports.ts';
import { assessLateEvidence } from '../trial-oracle/late-evidence/assess-late-evidence.ts';
import type { LateMonitoring } from '../trial-oracle/late-evidence/late-evidence-input.ts';
import type { AdmittedExecution } from './execution-ports.ts';
import { frozenProbeEvidence } from './frozen-probe-input.ts';
import { frozenTrialEvidence } from './frozen-trial-input.ts';
import { assessProbeLateEvidence } from './probe-late-evidence.ts';

/** What one package's late-evidence assessment reads. */
export interface PackageLateEvidenceInput {
  /** The package files as they are now, at package-relative paths. */
  readonly files: readonly PackageFile[];
  readonly admitted: AdmittedExecution;
  readonly monitoring: LateMonitoring;
  /** The late stream at `late-evidence/late-evidence-stream.jsonl`; absent when none was written. */
  readonly stream?: RawArtifact;
  readonly assessed_at: UtcMillis;
}

/**
 * Assesses the late evidence of a package's frozen trials or frozen probe result, or every reason
 * it cannot.
 *
 * @example
 * const assessment = assessPackageLateEvidence({ files, admitted, monitoring, stream, assessed_at }, validator);
 * if (assessment.ok) assessment.value.late_evidence_status; // 'none' when nothing correlated
 */
export function assessPackageLateEvidence(
  input: PackageLateEvidenceInput,
  validator: RecordValidator,
): Result<LateEvidenceAssessment, readonly StructuredReason[]> {
  const { admitted } = input;
  const stream = input.stream === undefined ? {} : { stream: input.stream };
  const identity = admitted.identity;
  if (identity.execution_kind === 'TRANSPORT_PROBE') {
    const probe = frozenProbeEvidence(input.files, admitted, validator);
    if (!probe.ok) {
      return err([probe.error]);
    }
    return assessProbeLateEvidence(
      {
        transport_probe_id: identity.transport_probe_id,
        execution_manifest_sha256: admitted.manifest_sha256,
        monitoring: input.monitoring,
        ...stream,
        ...(probe.value === undefined ? {} : { probe: probe.value }),
        assessed_at: input.assessed_at,
      },
      validator,
    );
  }
  const trials = frozenTrialEvidence(input.files, admitted.manifest, validator);
  if (!trials.ok) {
    return trials;
  }
  return assessLateEvidence(
    {
      execution: lateEvidenceIdentity(identity),
      execution_manifest_sha256: admitted.manifest_sha256,
      monitoring: input.monitoring,
      ...stream,
      trials: trials.value,
      assessed_at: input.assessed_at,
    },
    validator,
  );
}

/**
 * The trial execution's identity as a late-evidence assessment names it.
 *
 * @example
 * lateEvidenceIdentity({ execution_kind: 'RUN', run_id }); // { run_id }
 */
export function lateEvidenceIdentity(execution: TrialExecution): TrialExecutionIdentity {
  return execution.execution_kind === 'RUN'
    ? { run_id: execution.run_id }
    : { variant_validation_id: execution.variant_validation_id };
}
