// The runner's journal of one trial (design §7 `runner/runner-journal.jsonl`, BR-RUA-033). Each
// trial gets its own runner source instance, scoped to the trial partition, so every runner event
// of the trial carries `trial_id` and `trial_manifest_sha256` and the oracle attributes it to that
// trial (§8.1). The golden builder records one runner instance across the whole execution; both
// layouts are dense per (source, source_instance_id), which is all BR-RUA-033 asks
// (evidence/WP-26/decisions.md).
//
// An append that is not written stops the instance: the runner reports the reason and carries on,
// because the evidence it is collecting is still worth freezing, and ingestion then reports the
// missing event (BR-RUA-033 "a restart creates a new source instance").

import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import { createJsonlJournalPort } from '../event-journal/jsonl-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { JournalEvent } from '../event-journal/journal-event.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  Result,
  Sha256Hex,
  StructuredReason,
  UuidSource,
  Uuid4,
  WallClock,
} from '../record-contract/primitives.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { TrialExecution } from './trial-execution-ports.ts';

/** Identical retries of a definitively failed runner append (BR-RUA-033). */
export const RUNNER_DEFINITIVE_RETRIES = 2;

/** What the runner journal of one trial needs. */
export interface RunnerTrialJournalInput {
  readonly file: AppendOnlyFile;
  /** The execution's package directory, for example `runs/<run_id>`. */
  readonly package_directory: string;
  readonly execution: TrialExecution;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
  readonly clock: WallClock;
  readonly ids: UuidSource;
}

/** The runner events of one trial, appended in order. */
export class RunnerTrialJournal {
  readonly #writer: JournalWriter;

  constructor(input: RunnerTrialJournalInput) {
    const path = `${input.package_directory}/${EXECUTION_PATHS.runnerJournal}`;
    this.#writer = new JournalWriter({
      port: createJsonlJournalPort(path, input.file),
      source: 'runner',
      instanceId: input.ids.next(),
      scope: {
        execution: input.execution,
        execution_manifest_sha256: input.execution_manifest_sha256,
        partition: { kind: 'trial', trial_id: input.trial_id, trial_manifest_sha256: input.trial_manifest_sha256 },
      },
      clock: input.clock,
      ids: input.ids,
      maxDefinitiveRetries: RUNNER_DEFINITIVE_RETRIES,
    });
  }

  /**
   * Appends one runner event: the event as written, or why it was not.
   *
   * @example
   * const written = await journal.record('treatment_armed', { partition_key, treatment_state: 'ARMED', treatment_version: 1 });
   * if (written.ok) written.value.occurred_at;
   */
  async record<T extends EventRecordType>(
    type: T,
    body: EventBody<T>,
  ): Promise<Result<JournalEvent, StructuredReason>> {
    const appended = await this.#writer.append(type, body);
    if (appended.kind === 'appended') {
      return ok(appended.event);
    }
    return err({
      code: 'RUNNER_EVENT_NOT_WRITTEN',
      subject: 'BR-RUA-033',
      detail: `runner event ${type} was not appended (${appended.reason}: ${appended.detail}); expected it in ${EXECUTION_PATHS.runnerJournal}`,
    });
  }
}
