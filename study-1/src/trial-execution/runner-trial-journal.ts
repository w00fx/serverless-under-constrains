// The runner's journal of one capture unit, a trial or the transport probe (design §7
// `runner/runner-journal.jsonl`, BR-RUA-033). Each unit gets its own runner source instance,
// scoped to the unit's partition: every runner event of a trial carries `trial_id` and
// `trial_manifest_sha256`, so the oracle attributes it to that trial (§8.1), and every runner
// event of the probe carries only the execution identity, because the probe has no trial (D-06).
// The golden builder records one runner instance across the whole execution; both layouts are
// dense per (source, source_instance_id), which is all BR-RUA-033 asks
// (evidence/WP-26/decisions.md; generalized to the probe by evidence/CMP-04/decisions.md).
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
import type { Result, StructuredReason, UuidSource, WallClock } from '../record-contract/primitives.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { CaptureScope } from '../evidence-collection/capture-scope.ts';

/** Identical retries of a definitively failed runner append (BR-RUA-033). */
export const RUNNER_DEFINITIVE_RETRIES = 2;

/** What the runner journal of one trial or of the probe needs. */
export interface RunnerUnitJournalInput {
  readonly file: AppendOnlyFile;
  /** The execution's package directory, for example `runs/<run_id>`. */
  readonly package_directory: string;
  /** The execution, its manifest digest and the trial or probe whose partition the events name. */
  readonly scope: CaptureScope;
  readonly clock: WallClock;
  readonly ids: UuidSource;
}

/** The runner events of one trial or of the probe, appended in order. */
export class RunnerUnitJournal {
  readonly #writer: JournalWriter;

  constructor(input: RunnerUnitJournalInput) {
    const path = `${input.package_directory}/${EXECUTION_PATHS.runnerJournal}`;
    this.#writer = new JournalWriter({
      port: createJsonlJournalPort(path, input.file),
      source: 'runner',
      instanceId: input.ids.next(),
      scope: {
        execution: input.scope.execution,
        execution_manifest_sha256: input.scope.execution_manifest_sha256,
        partition: input.scope.unit,
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
