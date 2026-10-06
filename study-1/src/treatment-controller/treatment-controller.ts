// The controller half of BR-RUA-025 (design §5.3 L2 `treatment-controller/`, §9.11). One
// stream record per invocation: resolve its partition, read the configuration and treatment
// with strongly consistent reads, decide with the §9.11 table, and write exactly one journal
// record (the signal's together with its treatment transition). Domain outcomes return; only
// unreadable state, a stopped journal or a signal transaction without a definite result throw
// a ControllerFault, so the event source mapping retries a bounded number of times.
//
// A record the controller cannot attribute (not an INSERT, not a caller timeout, another
// execution's partition, a partition with no configuration, a canary without a usable digest)
// has no journal it could be recorded in, so it is ignored and only logged by the consumer.

import type { JournalWriter } from '../event-journal/journal-writer.ts';
import type { JournalScope } from '../event-journal/journal-scope.ts';
import { isSha256Hex } from '../record-contract/digests.ts';
import { boundedJsonText, describeJson } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, JsonValue, UuidSource } from '../record-contract/primitives.ts';
import type { ControllerConfigView, ControllerTreatment } from './controller-control-items.ts';
import { ControllerFault } from './controller-fault.ts';
import type { ControllerPartition } from './controller-partition.ts';
import { resolveControllerPartition } from './controller-partition.ts';
import type { AppendedDecision, SignalOnlyDecision } from './controller-records.ts';
import { appendDecisionRecord, prepareSignalRecord } from './controller-records.ts';
import type { ControllerStatePort, ControllerStateRead } from './controller-state-port.ts';
import { decodeTreatmentAfterConflict, SIGNAL_JOURNAL_ACTION_INDEX } from './controller-state-port.ts';
import type { SignalContext, SignalDecision } from './signal-decision.ts';
import { decideSignal } from './signal-decision.ts';
import type { StreamInsertRecord } from './stream-record.ts';
import { isConsumableInsert } from './stream-record.ts';

export interface TreatmentControllerDeps {
  readonly deployment: ExecutionIdentity;
  readonly state: ControllerStatePort;
  /** A new `treatment_controller` source instance writing to the experiment journal. */
  readonly openJournal: (scope: JournalScope) => JournalWriter;
  readonly ids: UuidSource;
}

/** What one stream record led to: a §9.11 decision, or no attributable record at all. */
export interface ControllerOutcome {
  readonly outcome: SignalDecision['kind'] | 'record_ignored';
  readonly partition_key: string | null;
  readonly detail: string;
}

/** A decision and the journal scope its record belongs to. */
interface DecisionInScope {
  readonly image: JsonValue;
  readonly decision: SignalDecision;
  readonly scope: JournalScope;
  readonly context: SignalContext;
}

export class TreatmentController {
  readonly #deps: TreatmentControllerDeps;

  constructor(deps: TreatmentControllerDeps) {
    this.#deps = deps;
  }

  /**
   * Handles one stream record. Throws a ControllerFault only when the outcome is not definite.
   *
   * @example
   * const result = await controller.handle(record); // { outcome: 'signal', partition_key, detail }
   */
  async handle(record: StreamInsertRecord): Promise<ControllerOutcome> {
    if (!isConsumableInsert(record)) {
      return ignored(
        null,
        `${record.event_name} of ${describeJson(record.new_image['record_type'])}; expected an INSERT of caller_timeout_recorded`,
      );
    }
    const partition = resolveControllerPartition(this.#deps.deployment, record.new_image.pk);
    if (partition === undefined) {
      return ignored(record.new_image.pk, 'partition not served by this deployment');
    }
    const planned = await this.#plan(record, partition);
    if (planned === undefined) {
      return ignored(partition.key, 'no journal scope: canary digest unusable or configuration absent');
    }
    return this.#execute(planned, partition.key);
  }

  async #plan(record: StreamInsertRecord, partition: ControllerPartition): Promise<DecisionInScope | undefined> {
    const deployment = this.#deps.deployment;
    if (partition.kind === 'canary') {
      const digest = record.new_image['execution_manifest_sha256'];
      if (!isSha256Hex(digest)) {
        return undefined;
      }
      const context: SignalContext = { kind: 'canary', deployment };
      const scope: JournalScope = {
        execution: deployment,
        execution_manifest_sha256: digest,
        partition: { kind: 'canary' },
      };
      return { image: record.new_image, decision: decideSignal(record.new_image, context, undefined), scope, context };
    }
    const configuration = required(await this.#deps.state.loadConfiguration(partition), partition.key);
    if (configuration === undefined) {
      return undefined;
    }
    const treatment = required(await this.#deps.state.loadTreatment(partition), partition.key);
    const context: SignalContext = { kind: 'experiment', deployment, configuration };
    const scope = experimentScope(deployment, configuration);
    return { image: record.new_image, decision: decideSignal(record.new_image, context, treatment), scope, context };
  }

  async #execute(planned: DecisionInScope, partitionKey: string): Promise<ControllerOutcome> {
    const journal = this.#deps.openJournal(planned.scope);
    const decision = planned.decision;
    if (decision.kind !== 'signal') {
      return appendOrFail(journal, decision, partitionKey);
    }
    return this.#signal(journal, decision, planned, partitionKey);
  }

  async #signal(
    journal: JournalWriter,
    decision: SignalOnlyDecision,
    planned: DecisionInScope,
    partitionKey: string,
  ): Promise<ControllerOutcome> {
    const prepared = prepareSignalRecord(journal, decision);
    if (prepared.kind === 'stopped') {
      throw new ControllerFault('JOURNAL_STOPPED', partitionKey, `signal record not prepared: ${prepared.reason}`);
    }
    const outcome = await this.#deps.state.signal({
      partition: partitionKey,
      attempt_id: decision.attempt_id,
      caller_timeout_event_id: decision.caller_timeout_event_id,
      event: prepared.put,
      token: this.#deps.ids.next(),
    });
    const confirmed = journal.confirm(prepared.put, outcome, SIGNAL_JOURNAL_ACTION_INDEX);
    if (confirmed.kind === 'appended') {
      return {
        outcome: 'signal',
        partition_key: partitionKey,
        detail: `signalled by ${decision.caller_timeout_event_id}`,
      };
    }
    if (confirmed.kind === 'stopped') {
      // Only an ambiguous append leaves the signal's effect unknown. Any other stop (another
      // event at the signal record's key, WP-05 review round 2) is a stopped journal instance.
      const code = confirmed.reason === 'AMBIGUOUS_APPEND' ? 'SIGNAL_AMBIGUOUS' : 'JOURNAL_STOPPED';
      throw new ControllerFault(code, partitionKey, `signal transaction ${confirmed.reason}; expected applied`);
    }
    if (outcome.kind !== 'condition_failed' || outcome.failed_action_index !== 0) {
      throw new ControllerFault(
        'SIGNAL_FAILED',
        partitionKey,
        `signal transaction ${boundedJsonText(outcome)}; expected applied or a failed treatment condition`,
      );
    }
    // design §9.11: a failed signal condition re-reads ALL_OLD and re-decides once.
    const existing = decodeTreatmentAfterConflict(outcome.existing);
    if (!existing.ok) {
      throw new ControllerFault('STATE_UNREADABLE', partitionKey, existing.error.detail);
    }
    return redecide(journal, planned, existing.value, partitionKey);
  }
}

async function redecide(
  journal: JournalWriter,
  planned: DecisionInScope,
  treatment: ControllerTreatment | undefined,
  partitionKey: string,
): Promise<ControllerOutcome> {
  const decision = decideSignal(planned.image, planned.context, treatment);
  if (decision.kind === 'signal') {
    throw new ControllerFault(
      'SIGNAL_REDECIDED_TO_SIGNAL',
      partitionKey,
      `treatment condition failed but ALL_OLD still admits the signal for ${decision.caller_timeout_event_id}; expected a changed treatment`,
    );
  }
  return appendOrFail(journal, decision, partitionKey);
}

async function appendOrFail(
  journal: JournalWriter,
  decision: AppendedDecision,
  partitionKey: string,
): Promise<ControllerOutcome> {
  const appended = await appendDecisionRecord(journal, decision);
  if (appended.kind === 'stopped') {
    throw new ControllerFault(
      'JOURNAL_STOPPED',
      partitionKey,
      `${decision.kind} record not written: ${appended.reason}`,
    );
  }
  return { outcome: decision.kind, partition_key: partitionKey, detail: `recorded ${appended.event.record_type}` };
}

function required<T>(read: ControllerStateRead<T>, partitionKey: string): T | undefined {
  if (!read.ok) {
    throw new ControllerFault('STATE_UNREADABLE', partitionKey, `${read.error.code}: ${read.error.detail}`);
  }
  return read.value;
}

// The configuration names a trial exactly in a trial partition (`decodeControllerConfig`).
function experimentScope(deployment: ExecutionIdentity, configuration: ControllerConfigView): JournalScope {
  const trial = configuration.trial;
  return {
    execution: deployment,
    execution_manifest_sha256: configuration.execution_manifest_sha256,
    partition:
      trial === undefined
        ? { kind: 'probe' }
        : { kind: 'trial', trial_id: trial.trial_id, trial_manifest_sha256: trial.trial_manifest_sha256 },
  };
}

function ignored(partitionKey: string | null, detail: string): ControllerOutcome {
  return { outcome: 'record_ignored', partition_key: partitionKey, detail };
}
