// BR-RUA-011 application timeout (BR-RUA-023, design §8.10, A-12). Θ must be durably present for
// T with at least three seconds of source-local monotonic elapsed time, the timer as the arbiter's
// winner, transport unsettled at the claim, the abort requested no later than the record, the
// dispatch as its cause and monotonic origin, and T's outcome `TIMED_OUT`. The writer's widened
// values (`arbiter_winner: TRANSPORT`, `transport_settled_at_claim: true`) are judged, not rejected:
// each is a conclusive violation. An outcome without Θ in a complete caller journal means T settled
// through transport.

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import { compareDecimal, isDecimalString } from '../record-contract/decimal.ts';
import type { DecimalString, JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import { finishCondition, idOf, refOf } from './condition-result.ts';
import type { ConditionDraft } from './condition-result.ts';
import type { EventOf } from './subject-events.ts';
import { causedBy } from './subject-events.ts';
import { incompleteArtifactReason } from './subject-artifacts.ts';
import type { TreatmentView } from './treatment-view.ts';

const CONDITION = 'BR-RUA-011';
/** BR-RUA-023: the application deadline, three seconds in nanoseconds. */
export const APPLICATION_DEADLINE_NS = '3000000000' as DecimalString;

const EXPECTED: JsonValue = {
  elapsed_ns_at_least: APPLICATION_DEADLINE_NS,
  arbiter_winner: 'TIMER',
  transport_settled_at_claim: false,
  abort_requested_at_not_after_recorded_at: true,
  caused_by_dispatch: true,
  outcome: 'TIMED_OUT',
};

/**
 * Judges BR-RUA-011 over the treatment view.
 *
 * @example
 * evaluateApplicationTimeout(view).result; // 'fail' when arbiter_winner is TRANSPORT
 */
export function evaluateApplicationTimeout(view: TreatmentView): ConditionResult {
  return finishCondition(CONDITION, draftOf(view), view.findings);
}

function draftOf(view: TreatmentView): ConditionDraft {
  const timeout = view.caller_timeout;
  const refs = [refOf(timeout), refOf(view.dispatch), refOf(view.outcome), view.journals.caller.ref];
  const draft = (result: ConditionDraft['result'], reasons: readonly StructuredReason[] = []): ConditionDraft => ({
    result,
    expected: EXPECTED,
    observed: observedOf(view),
    refs,
    reasons,
  });
  if (timeout === undefined) {
    return withoutTimeout(view, draft);
  }
  if (violatesTimerContract(timeout)) {
    return draft('fail');
  }
  const unjudgeable = correlationReason(view, timeout);
  return unjudgeable === undefined ? draft('pass') : draft('indeterminate', [unjudgeable]);
}

function withoutTimeout(
  view: TreatmentView,
  draft: (result: ConditionDraft['result'], reasons?: readonly StructuredReason[]) => ConditionDraft,
): ConditionDraft {
  const caller = view.journals.caller;
  if (view.outcome !== undefined && view.outcome.record.outcome !== 'TIMED_OUT' && caller.complete) {
    return draft('fail');
  }
  if (caller.ref === undefined) {
    return draft('indeterminate', [incompleteArtifactReason(caller, CONDITION)]);
  }
  const detail = `no caller_timeout_recorded for targeted attempt ${view.targeted_attempt_id ?? '(unknown)'}; expected the timer's durable event`;
  return draft('indeterminate', [reasonAt(CONDITION, 'EVENT_MISSING', detail, caller.ref)]);
}

// Each clause is a value the timeout event itself records against BR-RUA-023.
function violatesTimerContract(timeout: EventOf<'caller_timeout_recorded'>): boolean {
  const record = timeout.record;
  return (
    !isDecimalString(record.elapsed_ns) ||
    compareDecimal(record.elapsed_ns, APPLICATION_DEADLINE_NS) < 0 ||
    record.arbiter_winner !== 'TIMER' ||
    record.transport_settled_at_claim ||
    record.abort_requested_at > record.recorded_at
  );
}

// The event is sound; the condition still needs T's dispatch as its cause and a TIMED_OUT outcome.
function correlationReason(
  view: TreatmentView,
  timeout: EventOf<'caller_timeout_recorded'>,
): StructuredReason | undefined {
  const dispatch = view.dispatch;
  if (dispatch === undefined) {
    const detail = `no dispatch_started for targeted attempt ${timeout.record.attempt_id}; expected the timeout's cause`;
    return reasonAt(CONDITION, 'EVENT_MISSING', detail, view.journals.caller.ref);
  }
  if (!causedBy(timeout, dispatch) || timeout.record.monotonic_origin_event_id !== dispatch.record.event_id) {
    const detail = `caller_timeout_recorded names causation ${timeout.record.causation_event_ids.join(', ')} and monotonic origin ${timeout.record.monotonic_origin_event_id}; expected dispatch_started ${dispatch.record.event_id} for both`;
    return reasonAt(CONDITION, 'TIMEOUT_NOT_CORRELATED', detail, refOf(timeout));
  }
  const outcome = view.outcome?.record.outcome;
  if (outcome === 'TIMED_OUT') {
    return undefined;
  }
  const detail = `targeted attempt ${timeout.record.attempt_id} has outcome ${outcome ?? '(none)'}; expected TIMED_OUT`;
  return reasonAt(
    CONDITION,
    outcome === undefined ? 'EVENT_MISSING' : 'OUTCOME_NOT_TIMED_OUT',
    detail,
    view.journals.caller.ref,
  );
}

function observedOf(view: TreatmentView): JsonValue {
  const record = view.caller_timeout?.record;
  return {
    caller_timeout_event_id: idOf(view.caller_timeout),
    elapsed_ns: record?.elapsed_ns ?? null,
    arbiter_winner: record?.arbiter_winner ?? null,
    transport_settled_at_claim: record?.transport_settled_at_claim ?? null,
    abort_requested_at: record?.abort_requested_at ?? null,
    recorded_at: record?.recorded_at ?? null,
    causation_event_ids: record?.causation_event_ids ?? null,
    monotonic_origin_event_id: record?.monotonic_origin_event_id ?? null,
    dispatch_event_id: idOf(view.dispatch),
    outcome: view.outcome?.record.outcome ?? null,
  };
}
