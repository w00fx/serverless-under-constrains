// Attempts of a request that its state does not account for yet (design §5.3
// `reconcileOrphans`). An invocation that registered an attempt and then lost its environment
// (a Lambda timeout, a crash, a journal that stopped before the request state was written)
// leaves an attempt-state item that no `request_state_recorded` names. The next delivery folds
// it in before its own attempt, so effect knowledge never forgets a call that may have reached
// the provider (BR-RUA-021, BR-RUA-004).
//
// An orphan's class comes from its `attempt_outcome_recorded` event when one was written;
// otherwise from its durable phase: `NOT_DISPATCHED` proves a pre-dispatch failure, and
// `PRE_DISPATCH` or `DISPATCHED` without an outcome is ambiguous, because the dispatch
// transition or the transport may have happened (BR-RUA-021 conservative dispatch).
//
// Orphans are returned in sort-key order (the partition query order). Each invocation reconciles
// before it attempts, so at most one orphan exists at a time and the order never decides the
// knowledge in practice.

import { classifyOutcome } from '../../attempt-lifecycle/outcome-classification.ts';
import type { OutcomeClass } from '../../attempt-lifecycle/outcome-classification.ts';
import type { StoredItem } from '../../durable-store/item-store-port.ts';
import { describeJson } from '../../record-contract/json-value.ts';
import type { Result, Uuid4 } from '../../record-contract/primitives.ts';
import { err, ok } from '../../record-contract/primitives.ts';
import { isUuid4 } from '../../record-contract/identifiers.ts';
import { ATTEMPT_OUTCOMES, DISPATCH_STATES } from '../../record-contract/records/group-b/vocabulary.ts';
import { ATTEMPT_PHASES, ATTEMPT_STATE_SK_PREFIX } from '../../provider-client/attempt-state-port.ts';
import type { AttemptPhase } from '../../provider-client/attempt-state-port.ts';
import { ownField } from '../../trial-message/trial-message-fields.ts';
import { isOneOf } from './request-state-item.ts';

/** An attempt the request state has not accounted for, with the class it adds. */
export interface OrphanAttempt {
  readonly attempt_id: Uuid4;
  readonly outcome_class: OutcomeClass;
}

interface AttemptStateItem {
  readonly attempt_id: Uuid4;
  readonly refund_request_id: string;
  readonly phase: AttemptPhase;
}

/**
 * The orphans of `refundRequestId` among the items of one trial partition. The failure names an
 * attempt-state item that cannot be read, because a damaged item could hide an attempt.
 *
 * @example
 * const orphans = findOrphanAttempts(partitionItems, 'ref-poc-001', new Set(current.attempt_ids));
 * if (orphans.ok && orphans.value.length > 0) recordRunning(orphans.value);
 */
export function findOrphanAttempts(
  items: readonly StoredItem[],
  refundRequestId: string,
  accounted: ReadonlySet<string>,
): Result<readonly OrphanAttempt[], string> {
  const states: AttemptStateItem[] = [];
  for (const item of items.filter((candidate) => candidate.sk.startsWith(ATTEMPT_STATE_SK_PREFIX))) {
    const state = parseAttemptStateItem(item);
    if (!state.ok) {
      return state;
    }
    states.push(state.value);
  }
  const outcomes = recordedOutcomeClasses(items);
  return ok(
    states
      .filter((state) => state.refund_request_id === refundRequestId && !accounted.has(state.attempt_id))
      .map((state) => ({
        attempt_id: state.attempt_id,
        outcome_class: outcomes.get(state.attempt_id) ?? classOfPhase(state.phase),
      })),
  );
}

function parseAttemptStateItem(item: StoredItem): Result<AttemptStateItem, string> {
  const attemptId = ownField(item, 'attempt_id');
  const refundRequestId = ownField(item, 'refund_request_id');
  const phase = ownField(item, 'phase');
  if (!isUuid4(attemptId) || typeof refundRequestId !== 'string' || !isOneOf(ATTEMPT_PHASES, phase)) {
    return err(
      `attempt-state item ${item.sk}: attempt_id ${describeJson(attemptId)}, refund_request_id ${describeJson(refundRequestId)}, phase ${describeJson(phase)}; expected a UUIDv4, a string and one of ${ATTEMPT_PHASES.join(', ')}`,
    );
  }
  return ok({ attempt_id: attemptId, refund_request_id: refundRequestId, phase });
}

// The class of every attempt whose outcome event the partition holds. An outcome event this
// reader cannot classify is left out, so its attempt falls back to its phase.
function recordedOutcomeClasses(items: readonly StoredItem[]): ReadonlyMap<string, OutcomeClass> {
  const classes = new Map<string, OutcomeClass>();
  for (const item of items.filter((candidate) => ownField(candidate, 'record_type') === 'attempt_outcome_recorded')) {
    const outcome = ownField(item, 'outcome');
    const dispatch = ownField(item, 'dispatch_state');
    const attemptId = ownField(item, 'attempt_id');
    const cls =
      isOneOf(ATTEMPT_OUTCOMES, outcome) && isOneOf(DISPATCH_STATES, dispatch)
        ? classifyOutcome(outcome, dispatch)
        : undefined;
    if (typeof attemptId === 'string' && cls?.ok === true) {
      classes.set(attemptId, cls.value);
    }
  }
  return classes;
}

function classOfPhase(phase: AttemptPhase): OutcomeClass {
  return phase === 'NOT_DISPATCHED' ? 'PRE_DISPATCH_FAILURE' : 'AMBIGUOUS';
}
