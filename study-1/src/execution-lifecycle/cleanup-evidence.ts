// The evidence steps of cleanup (design §10.4 steps 1, 2, 4, 7 and 12; BR-RUA-048, BR-RUA-049).
// Cleanup owns the order and the journal; the runner owns the artifacts:
// - steps 1 and 2: the late-evidence cutoff and assessment (`LateEvidenceSteps`);
// - step 4: `pre-cleanup-snapshot.json`, best effort, its failures recorded in the record;
// - step 7: the DLQ messages the trials captured (their `queues/dlq-snapshot.json`), so that step 8
//   deletes exactly those and never a message no package holds;
// - step 12: the cleanup and leak-audit results, frozen once.
// The same port serves operational recovery, which writes into its amendment payload instead of
// the package (BR-RUA-038), through the `sink` and `paths` it is given.

import type { CleanupResults, CleanupEvidencePort, DlqCaptureReport, StepReport } from '../cleanup/cleanup-ports.ts';
import { capturePreCleanupSnapshot } from '../evidence-collection/pre-cleanup-snapshot.ts';
import type { PreCleanupPlan } from '../evidence-collection/pre-cleanup-snapshot.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { UNIT_PATHS } from '../evidence-package/package-layout.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { StudyRecord } from '../record-contract/records/index.ts';
import type { DlqSnapshot } from '../record-contract/records/group-b/dlq_snapshot.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import type { ExecutionEvidenceReaders, ExecutionServices } from './execution-ports.ts';
import type { ExecutionPackage } from './execution-package.ts';
import type { LateEvidenceSteps } from './late-evidence-freeze.ts';

/** Where a write of cleanup evidence lands: the package, or a recovery's amendment payload. */
export interface EvidenceSink {
  writeOnce(path: string, bytes: Uint8Array): Promise<StructuredReason | undefined>;
}

/** The paths of the files cleanup evidence writes, relative to its sink. */
export interface CleanupEvidencePaths {
  readonly pre_cleanup_snapshot: string;
  readonly cleanup_result: string;
  readonly leak_audit_result: string;
}

/** What the evidence steps read and write. */
export interface CleanupEvidenceContext {
  /** The execution's package, read for the trials' DLQ snapshots. */
  readonly pkg: ExecutionPackage;
  readonly sink: EvidenceSink;
  readonly paths: CleanupEvidencePaths;
  readonly late: LateEvidenceSteps;
  readonly readers: ExecutionEvidenceReaders;
  /** The pre-cleanup snapshot's scope: partitions, Durable listings and queues. */
  readonly snapshot: Omit<PreCleanupPlan, 'cleanup_mode'>;
  readonly services: ExecutionServices;
}

const DLQ_SNAPSHOT_SUFFIX = `/${UNIT_PATHS.dlqSnapshot}`;

/**
 * The runner's binding of cleanup's evidence port.
 *
 * @example
 * const orchestrator = new CleanupOrchestrator({ ...bindings, evidence: new ExecutionCleanupEvidence(context), journal, safety, clock });
 */
export class ExecutionCleanupEvidence implements CleanupEvidencePort {
  readonly #context: CleanupEvidenceContext;

  constructor(context: CleanupEvidenceContext) {
    this.#context = context;
  }

  completeLateEvidenceCutoff(): Promise<StepReport> {
    return this.#context.late.cutoff();
  }

  freezeLateEvidenceAssessment(): Promise<StepReport> {
    return this.#context.late.freezeAssessment();
  }

  async capturePreCleanupSnapshot(mode: CleanupMode): Promise<StepReport> {
    const { readers, services, snapshot } = this.#context;
    const capture = await capturePreCleanupSnapshot(
      { store: readers.store, queues: readers.queues, durable: readers.durable, clock: services.clock },
      { ...snapshot, cleanup_mode: mode },
    );
    // The snapshot is built from JSON values read back from the ports, so it always serializes.
    const bytes = serializeRecordFile(capture.record as unknown as StudyRecord);
    return this.#written(await this.#context.sink.writeOnce(this.#context.paths.pre_cleanup_snapshot, bytes));
  }

  async captureDlqEvidence(): Promise<DlqCaptureReport> {
    const files = await this.#context.pkg.snapshot();
    if (!files.ok) {
      return { status: 'failed', reasons: [files.error], captured_message_ids: [] };
    }
    const snapshots = files.value.filter(
      (file) => file.path.startsWith('trials/') && file.path.endsWith(DLQ_SNAPSHOT_SUFFIX),
    );
    const read = snapshots.map((file) => capturedMessageIds(file, this.#context.services));
    const reasons = read.flatMap((ids) => (ids.ok ? [] : [ids.error]));
    return {
      status: reasons.length === 0 ? 'succeeded' : 'failed',
      reasons,
      captured_message_ids: read.flatMap((ids) => (ids.ok ? ids.value : [])),
    };
  }

  async freezeResults(results: CleanupResults): Promise<StepReport> {
    const { sink, paths } = this.#context;
    const reasons = [
      await sink.writeOnce(paths.cleanup_result, serializeRecordFile(results.cleanup_result)),
      await sink.writeOnce(paths.leak_audit_result, serializeRecordFile(results.leak_audit_result)),
    ].filter((reason) => reason !== undefined);
    return { status: reasons.length === 0 ? 'succeeded' : 'failed', reasons };
  }

  #written(unwritten: StructuredReason | undefined): StepReport {
    return unwritten === undefined ? { status: 'succeeded', reasons: [] } : { status: 'failed', reasons: [unwritten] };
  }
}

// The message ids one trial's DLQ snapshot captured, or why the snapshot cannot be read.
function capturedMessageIds(
  file: PackageFile,
  services: ExecutionServices,
): Result<readonly string[], StructuredReason> {
  const parsed = parseJsonDocument(file.bytes);
  const checked = parsed.ok ? services.validator.validateAs('dlq_snapshot', parsed.value) : undefined;
  if (checked?.valid !== true) {
    return err({
      code: 'DLQ_SNAPSHOT_UNREADABLE',
      subject: 'BR-RUA-048',
      artifact_path: file.path,
      detail: `${file.path} is not a valid dlq_snapshot; expected the trial's captured DLQ messages`,
    });
  }
  return ok((checked.record as DlqSnapshot).messages.map((message) => message.message_id));
}
