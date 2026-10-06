// The runner's execution-level events (design §7 `runner/runner-journal.jsonl`, §10.2; BR-RUA-033,
// CTR-RUA-002). Each phase P1-P9 records `phase_transition_recorded` when it starts and when it
// ends, and an interruption the runner observes outside a trial (between trials, during
// provisioning, readiness or monitoring) records `trial_interrupted` without a trial id, so the run
// terminal reason names the interruption cause instead of an incomplete trial. Trials keep their own
// runner instances (`RunnerTrialJournal`); this one is scoped to the execution partition.
//
// A stopped writer is reported and the runner carries on: the evidence it is about to collect is
// still worth freezing, and the missing event shows in the package (BR-RUA-033).

import type { AppendOnlyFile } from '../event-journal/append-only-file.ts';
import { createJsonlJournalPort } from '../event-journal/jsonl-journal-port.ts';
import { JournalWriter } from '../event-journal/journal-writer.ts';
import type { EventBody } from '../event-journal/journal-event.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import type { StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import type { ExecutionPhase, StepStatus } from '../record-contract/records/group-b/vocabulary.ts';
import { RUNNER_DEFINITIVE_RETRIES } from '../trial-execution/runner-trial-journal.ts';
import type { TrialInterruption } from '../trial-execution/trial-execution-ports.ts';
import type { AdmittedExecution, ExecutionServices } from './execution-ports.ts';

/**
 * The execution-scoped runner instance of one execution.
 *
 * @example
 * const journal = new ExecutionPhaseJournal(admitted, files, services);
 * await journal.phase('LEASE_ACQUISITION', 'started');
 */
export class ExecutionPhaseJournal {
  readonly #writer: JournalWriter;
  readonly #services: ExecutionServices;

  constructor(admitted: AdmittedExecution, file: AppendOnlyFile, services: ExecutionServices) {
    this.#services = services;
    this.#writer = new JournalWriter({
      port: createJsonlJournalPort(`${admitted.package_directory}/${EXECUTION_PATHS.runnerJournal}`, file),
      source: 'runner',
      instanceId: services.ids.next(),
      scope: {
        execution: admitted.identity,
        execution_manifest_sha256: admitted.manifest_sha256,
        partition: { kind: 'execution' },
      },
      clock: services.clock,
      ids: services.ids,
      maxDefinitiveRetries: RUNNER_DEFINITIVE_RETRIES,
    });
  }

  /**
   * Records one phase transition; the event id, or `undefined` when it was not written.
   *
   * @example
   * await journal.phase('PROVISIONING', 'failed', reasons);
   */
  phase(
    phase: ExecutionPhase,
    status: StepStatus,
    reasons: readonly StructuredReason[] = [],
  ): Promise<Uuid4 | undefined> {
    return this.#record('phase_transition_recorded', { phase, status, reasons: [...reasons] });
  }

  /**
   * Records an interruption no trial recorded.
   *
   * @example
   * await journal.interrupted({ cause: 'SAFETY_DEADLINE', detail: 'the active-time deadline was reached' });
   */
  async interrupted(interruption: TrialInterruption): Promise<void> {
    await this.#record('trial_interrupted', { cause: interruption.cause, detail: interruption.detail });
  }

  async #record<T extends EventRecordType>(type: T, body: EventBody<T>): Promise<Uuid4 | undefined> {
    const appended = await this.#writer.append(type, body);
    if (appended.kind === 'appended') {
      return appended.event.event_id;
    }
    this.#services.log({
      level: 'error',
      event: 'runner_event_not_written',
      detail: `${type} was not appended (${appended.reason}: ${appended.detail}); expected it in ${EXECUTION_PATHS.runnerJournal}`,
    });
    return undefined;
  }
}
