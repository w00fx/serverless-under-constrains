// One admission attempt's evidence (BR-RUA-039, design §7, §10.1): every step appends one
// `preflight_check_recorded` line to `admission-attempts/<id>/preflight-journal.jsonl`, in step
// order with a dense sequence; the first failing step also writes `admission-rejection.json` next
// to it, and the journal is finalized. Nothing here writes under a package root. When the
// attempt's own evidence cannot be written, the attempt ends `failed`: admission never continues
// past a check it could not record, and never reports a rejection it could not store.

import { join } from 'node:path';

import { serializeJsonl, serializeRecordFile } from '../record-contract/canonical-json.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { ExecutionKind, StructuredReason, Uuid4, WallClock } from '../record-contract/primitives.ts';
import type { AdmissionCheckId } from '../record-contract/records/group-a/admission_rejection.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { AssemblyFileSystem } from '../deployment-assembly/assembly-file-system.ts';
import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import { PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import type { AdmissionOutcome } from './admission-ports.ts';
import { admissionReason } from './admission-reason.ts';
import { preflightRecord, rejectionRecord } from './preflight-check.ts';
import type { StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-039';
/** File names inside `admission-attempts/<id>/`. */
export const ATTEMPT_FILES = {
  preflightJournal: 'preflight-journal.jsonl',
  admissionRejection: 'admission-rejection.json',
} as const;
const RECORD_FILE_MODE = 0o644;

/** A step's result for the orchestrator: go on with its value, or stop with the outcome. */
export type StepContinuation<T> =
  { readonly kind: 'continue'; readonly value: T } | { readonly kind: 'stop'; readonly outcome: AdmissionOutcome };

export interface AdmissionAttemptDeps {
  readonly journal: AppendOnlyFile;
  readonly files: AssemblyFileSystem;
  readonly clock: WallClock;
  /** Absolute evidence root. */
  readonly evidence_root: string;
}

/**
 * The journal and rejection writer of one attempt.
 *
 * @example
 * const attempt = new AdmissionAttempt(attemptId, 'RUN', deps);
 * const step = await attempt.record('A2', assessEnvironmentInput(bytes, validator));
 * if (step.kind === 'stop') return step.outcome;
 */
export class AdmissionAttempt {
  readonly admission_attempt_id: Uuid4;
  readonly #kind: ExecutionKind;
  readonly #deps: AdmissionAttemptDeps;
  readonly #lines: Uint8Array[] = [];
  #sequence = 0;

  constructor(admissionAttemptId: Uuid4, kind: ExecutionKind, deps: AdmissionAttemptDeps) {
    this.admission_attempt_id = admissionAttemptId;
    this.#kind = kind;
    this.#deps = deps;
  }

  /** `admission-attempts/<id>`, relative to the evidence root. */
  get directory(): string {
    return PACKAGE_LAYOUT.admissionAttemptDirectory(this.admission_attempt_id);
  }

  /** Every journal line appended so far, as the exact bytes on disk. */
  journalBytes(): Uint8Array {
    const bytes = new Uint8Array(this.#lines.reduce((total, line) => total + line.length, 0));
    let offset = 0;
    for (const line of this.#lines) {
      bytes.set(line, offset);
      offset += line.length;
    }
    return bytes;
  }

  /**
   * Appends the step's record; a failing step also ends the attempt as rejected.
   *
   * @example
   * await attempt.record('A3', assessFinancialInput(request.financial_inputs));
   */
  async record<T>(checkId: AdmissionCheckId, verdict: StepVerdict<T>): Promise<StepContinuation<T>> {
    const at = formatUtcMillis(this.#deps.clock.now());
    this.#sequence += 1;
    const line = serializeJsonl([
      preflightRecord(
        {
          admission_attempt_id: this.admission_attempt_id,
          sequence: this.#sequence,
          check_id: checkId,
          checked_at: at,
        },
        verdict,
      ),
    ]);
    const appended = await this.#deps.journal.append(this.#path(ATTEMPT_FILES.preflightJournal), line);
    if (appended.kind !== 'appended') {
      return this.#failed([unwritable('preflight journal', appended.code)]);
    }
    this.#lines.push(line);
    if (verdict.passed) {
      return { kind: 'continue', value: verdict.value };
    }
    return { kind: 'stop', outcome: await this.#reject(checkId, verdict) };
  }

  /**
   * Finalizes the journal; `undefined` when it is now read-only, else the reason it is not.
   *
   * @example
   * const problem = await attempt.finalize();
   */
  async finalize(): Promise<StructuredReason | undefined> {
    const finalized = await this.#deps.journal.finalize(this.#path(ATTEMPT_FILES.preflightJournal));
    return finalized.kind === 'finalized' ? undefined : unwritable('preflight journal finalization', finalized.code);
  }

  /**
   * Ends the attempt as failed: its evidence could not be written, so nothing is admitted.
   *
   * @example
   * return attempt.fail([reason]);
   */
  async fail(reasons: readonly StructuredReason[]): Promise<AdmissionOutcome> {
    return (await this.#failed(reasons)).outcome;
  }

  async #reject(
    checkId: AdmissionCheckId,
    verdict: Extract<StepVerdict<unknown>, { readonly passed: false }>,
  ): Promise<AdmissionOutcome> {
    const rejection = rejectionRecord(
      this.admission_attempt_id,
      this.#kind,
      checkId,
      verdict,
      formatUtcMillis(this.#deps.clock.now()),
    );
    const rejectionPath = `${this.directory}/${ATTEMPT_FILES.admissionRejection}`;
    const written = await this.#deps.files.createFile(
      join(this.#deps.evidence_root, rejectionPath),
      serializeRecordFile(rejection),
      RECORD_FILE_MODE,
    );
    if (!written.ok) {
      return (await this.#failed([unwritable('admission rejection', written.error.code), ...verdict.reasons])).outcome;
    }
    const finalized = await this.finalize();
    if (finalized !== undefined) {
      return (await this.#failed([finalized, ...verdict.reasons])).outcome;
    }
    return {
      kind: 'rejected',
      admission_attempt_id: this.admission_attempt_id,
      rejection_path: rejectionPath,
      reasons: verdict.reasons,
    };
  }

  // A failed attempt still tries to finalize its journal, so no later process appends to it.
  async #failed(
    reasons: readonly StructuredReason[],
  ): Promise<{ readonly kind: 'stop'; readonly outcome: AdmissionOutcome }> {
    await this.#deps.journal.finalize(this.#path(ATTEMPT_FILES.preflightJournal));
    return { kind: 'stop', outcome: { kind: 'failed', admission_attempt_id: this.admission_attempt_id, reasons } };
  }

  #path(file: string): string {
    return join(this.#deps.evidence_root, this.directory, file);
  }
}

function unwritable(what: string, code: string): StructuredReason {
  return admissionReason(
    'ADMISSION_EVIDENCE_UNWRITABLE',
    SUBJECT,
    `the attempt's ${what} could not be written (${boundedText(code)}); expected every admission check recorded`,
  );
}
