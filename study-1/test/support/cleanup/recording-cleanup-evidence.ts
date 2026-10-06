// The offline evidence steps of cleanup (steps 1, 2, 4, 7 and 12, owned by other features): it
// records each call with its mode and answers `succeeded` unless a test scripts another report
// or a throw. Step 7 captures the DLQ messages a test declares; step 12 keeps what it froze.

import type {
  CleanupEvidencePort,
  CleanupResults,
  DlqCaptureReport,
  StepReport,
} from '../../../src/cleanup/cleanup-ports.ts';
import type { CleanupMode } from '../../../src/record-contract/records/group-b/vocabulary.ts';

export type EvidenceOperation = 'cutoff' | 'assessment' | 'snapshot' | 'dlq' | 'freeze';

export interface EvidenceCall {
  readonly operation: EvidenceOperation;
  readonly mode?: CleanupMode;
}

const SUCCEEDED: StepReport = { status: 'succeeded', reasons: [] };

/**
 * Records the evidence steps cleanup asks for and answers them as scripted.
 *
 * @example
 * const evidence = new RecordingCleanupEvidence();
 * evidence.captureMessages('m-1');
 * await evidence.captureDlqEvidence('NORMAL'); // { status: 'succeeded', reasons: [], captured_message_ids: ['m-1'] }
 */
export class RecordingCleanupEvidence implements CleanupEvidencePort {
  readonly #calls: EvidenceCall[] = [];
  readonly #reports = new Map<EvidenceOperation, StepReport>();
  readonly #throwing = new Set<EvidenceOperation>();
  readonly #frozen: CleanupResults[] = [];
  #captured: string[] = [];

  /** Every later call of `operation` answers `report`. */
  answer(operation: EvidenceOperation, report: StepReport): void {
    this.#reports.set(operation, report);
  }

  /** Every later call of `operation` throws. */
  throwOn(operation: EvidenceOperation): void {
    this.#throwing.add(operation);
  }

  /** The DLQ messages the next captures report. */
  captureMessages(...messageIds: readonly string[]): void {
    this.#captured = [...messageIds];
  }

  calls(): readonly EvidenceCall[] {
    return [...this.#calls];
  }

  /** What each step-12 call froze, in call order. */
  frozen(): readonly CleanupResults[] {
    return [...this.#frozen];
  }

  completeLateEvidenceCutoff(mode: CleanupMode): Promise<StepReport> {
    return this.#answer('cutoff', mode);
  }

  freezeLateEvidenceAssessment(mode: CleanupMode): Promise<StepReport> {
    return this.#answer('assessment', mode);
  }

  capturePreCleanupSnapshot(mode: CleanupMode): Promise<StepReport> {
    return this.#answer('snapshot', mode);
  }

  async captureDlqEvidence(mode: CleanupMode): Promise<DlqCaptureReport> {
    const report = await this.#answer('dlq', mode);
    return { ...report, captured_message_ids: [...this.#captured] };
  }

  freezeResults(results: CleanupResults): Promise<StepReport> {
    this.#frozen.push(results);
    return this.#answer('freeze', undefined);
  }

  #answer(operation: EvidenceOperation, mode: CleanupMode | undefined): Promise<StepReport> {
    this.#calls.push(mode === undefined ? { operation } : { operation, mode });
    if (this.#throwing.has(operation)) {
      return Promise.reject(new Error(`scripted ${operation} evidence fault`));
    }
    return Promise.resolve(this.#reports.get(operation) ?? SUCCEEDED);
  }
}
