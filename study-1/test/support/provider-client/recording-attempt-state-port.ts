// The durable-transition double of AC-RUA-015 (design §12.2): an in-memory AttemptStatePort that
// applies the same conditional transitions as `createDurableAttemptStatePort` over DynamoDB
// (registration only when absent; each transition only from PRE_DISPATCH; the journal event
// lands exactly when the state changes) and records every call with its outcome. The
// conformance test runs it side by side with the durable port over InMemoryItemStore.
//
// Fault injection, one script per call of the named operation, consumed in order:
// - definitive_failure: nothing changes (the store refused the transaction);
// - ambiguous: the response is lost; `applied` says whether the transaction took effect;
// - condition_failed: nothing changes, and `existing` is reported as the ALL_OLD item;
// Without a fault, a failed condition reports the current state item as `existing`, exactly as
// the store's `ReturnValuesOnConditionCheckFailure: ALL_OLD` does.
// - throw: the port throws instead of returning an outcome, as a defective port would.

import type { StoredItem, WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { PreparedJournalPut } from '../../../src/event-journal/journal-writer.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import type {
  AttemptPhase,
  AttemptRegistration,
  AttemptStatePort,
} from '../../../src/provider-client/attempt-state-port.ts';
import { attemptStateSortKey } from '../../../src/provider-client/attempt-state-port.ts';

export type AttemptOperation = 'registerPreDispatch' | 'transitionToNotDispatched' | 'transitionToDispatched';

export type ScriptedTransitionFault =
  | { readonly kind: 'definitive_failure'; readonly code: string }
  | { readonly kind: 'ambiguous'; readonly code: string; readonly applied: boolean }
  | { readonly kind: 'condition_failed'; readonly existing?: StoredItem }
  | { readonly kind: 'throw'; readonly error: Error };

export interface RecordedTransition {
  readonly operation: AttemptOperation;
  readonly attempt_id: Uuid4;
  readonly event_type: JournalEvent['record_type'];
  /** The outcome returned, or `thrown` when the port threw. */
  readonly outcome: WriteOutcome | { readonly kind: 'thrown' };
}

// The state action follows the journal put in the durable port's transaction (index 1).
const STATE_ACTION_INDEX = 1;

export class RecordingAttemptStatePort implements AttemptStatePort {
  readonly #items = new Map<Uuid4, StoredItem>();
  readonly #faults = new Map<AttemptOperation, ScriptedTransitionFault[]>();
  readonly #calls: RecordedTransition[] = [];
  readonly #committed: JournalEvent[] = [];

  registerPreDispatch(registration: AttemptRegistration, event: PreparedJournalPut): Promise<WriteOutcome> {
    const existing = this.#items.get(registration.attempt_id);
    const next: StoredItem = {
      pk: event.key.pk,
      sk: attemptStateSortKey(registration.attempt_id),
      attempt_id: registration.attempt_id,
      provider_request_id: registration.provider_request_id,
      refund_request_id: registration.refund_request_id,
      phase: 'PRE_DISPATCH' satisfies AttemptPhase,
    };
    return this.#run('registerPreDispatch', registration.attempt_id, event, {
      existing,
      allowed: existing === undefined,
      next,
    });
  }

  transitionToNotDispatched(attemptId: Uuid4, event: PreparedJournalPut): Promise<WriteOutcome> {
    return this.#run('transitionToNotDispatched', attemptId, event, this.#transition(attemptId, 'NOT_DISPATCHED'));
  }

  transitionToDispatched(attemptId: Uuid4, event: PreparedJournalPut): Promise<WriteOutcome> {
    return this.#run('transitionToDispatched', attemptId, event, this.#transition(attemptId, 'DISPATCHED'));
  }

  /** Queues a fault for the next call of `operation`. */
  scriptNext(operation: AttemptOperation, fault: ScriptedTransitionFault): void {
    this.#faults.set(operation, [...(this.#faults.get(operation) ?? []), fault]);
  }

  /** The current phase of an attempt, or undefined when it was never registered. */
  phaseOf(attemptId: Uuid4): AttemptPhase | undefined {
    return this.#items.get(attemptId)?.['phase'] as AttemptPhase | undefined;
  }

  /** The state item of an attempt as the durable port would store it. */
  stateItemOf(attemptId: Uuid4): StoredItem | undefined {
    return this.#items.get(attemptId);
  }

  calls(): readonly RecordedTransition[] {
    return [...this.#calls];
  }

  /** The journal events of every transaction that took effect, in order. */
  committedEvents(): readonly JournalEvent[] {
    return [...this.#committed];
  }

  #transition(attemptId: Uuid4, to: Exclude<AttemptPhase, 'PRE_DISPATCH'>): StateChange {
    const existing = this.#items.get(attemptId);
    const allowed = existing?.['phase'] === 'PRE_DISPATCH';
    // Without an existing item the condition fails, so the placeholder key is never committed.
    return { existing, allowed, next: { ...(existing ?? { pk: '', sk: '' }), phase: to } };
  }

  #run(
    operation: AttemptOperation,
    attemptId: Uuid4,
    event: PreparedJournalPut,
    change: StateChange,
  ): Promise<WriteOutcome> {
    const fault = this.#faults.get(operation)?.shift();
    const record = (outcome: RecordedTransition['outcome']): void => {
      this.#calls.push({ operation, attempt_id: attemptId, event_type: event.event.record_type, outcome });
    };
    if (fault?.kind === 'throw') {
      record({ kind: 'thrown' });
      return Promise.reject(fault.error);
    }
    const outcome = this.#apply(fault, attemptId, event, change);
    record(outcome);
    return Promise.resolve(outcome);
  }

  #apply(
    fault: Exclude<ScriptedTransitionFault, { readonly kind: 'throw' }> | undefined,
    attemptId: Uuid4,
    event: PreparedJournalPut,
    change: StateChange,
  ): WriteOutcome {
    if (fault?.kind === 'definitive_failure') {
      return { kind: 'definitive_failure', code: fault.code };
    }
    if (fault?.kind === 'condition_failed') {
      return conditionFailed(fault.existing);
    }
    if (fault?.kind === 'ambiguous') {
      // A lost response never makes a transaction whose condition fails take effect.
      this.#commit(fault.applied && change.allowed, attemptId, event, change.next);
      return { kind: 'ambiguous', code: fault.code };
    }
    if (!change.allowed) {
      return conditionFailed(change.existing);
    }
    this.#commit(true, attemptId, event, change.next);
    return { kind: 'applied' };
  }

  #commit(applied: boolean, attemptId: Uuid4, event: PreparedJournalPut, next: StoredItem): void {
    if (!applied) {
      return;
    }
    this.#items.set(attemptId, next);
    this.#committed.push(event.event);
  }
}

// What one operation would change: the current item, whether its condition holds, and the item
// it writes when it does.
interface StateChange {
  readonly existing: StoredItem | undefined;
  readonly allowed: boolean;
  readonly next: StoredItem;
}

function conditionFailed(existing: StoredItem | undefined): WriteOutcome {
  return existing === undefined
    ? { kind: 'condition_failed', failed_action_index: STATE_ACTION_INDEX }
    : { kind: 'condition_failed', failed_action_index: STATE_ACTION_INDEX, existing };
}
