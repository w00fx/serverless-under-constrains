// BR-RUA-015 no caller-observed success (design §8.10, D-26, AC-RUA-031). The caller must never
// observe a successful provider response for T: T's outcome is `TIMED_OUT` and no caller event of
// T carries K's `provider_transaction_id`. A `SUCCEEDED` outcome or a caller event carrying K's
// transaction fails the condition. A missing outcome leaves it indeterminate. A transport that
// settled after the timer won (`transport_settled_after_timeout`, even `resolved`) is reported in
// `observed` and never fails the condition by itself: its payload is never parsed.

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { IndexedEvent } from '../evidence-ingestion/ingestion-model.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import { finishCondition, refOf } from './condition-result.ts';
import type { ConditionDraft } from './condition-result.ts';
import { eventString } from './subject-events.ts';
import { incompleteArtifactReason } from './subject-artifacts.ts';
import type { TreatmentView } from './treatment-view.ts';

const CONDITION = 'BR-RUA-015';

/**
 * Judges BR-RUA-015 over the treatment view.
 *
 * @example
 * evaluateNoCallerSuccess(view).result; // 'fail' when T's outcome is SUCCEEDED
 */
export function evaluateNoCallerSuccess(view: TreatmentView): ConditionResult {
  return finishCondition(CONDITION, draftOf(view), view.findings);
}

function draftOf(view: TreatmentView): ConditionDraft {
  const carrying = carryingEvents(view);
  const refs = [refOf(view.outcome), ...carrying.map(refOf), ...view.late_settlements.map(refOf)];
  const draft = (result: ConditionDraft['result'], reasons: readonly StructuredReason[] = []): ConditionDraft => ({
    result,
    expected: expectedOf(view),
    observed: observedOf(view, carrying),
    refs,
    reasons,
  });
  const outcome = view.outcome?.record.outcome;
  if (outcome === 'SUCCEEDED' || carrying.length > 0) {
    return draft('fail');
  }
  if (outcome === 'TIMED_OUT') {
    return draft('pass');
  }
  return { ...draft('indeterminate', [outcomeReason(view)]), refs: [...refs, view.journals.caller.ref] };
}

// Only K's transaction proves the caller saw the targeted commit's success.
function carryingEvents(view: TreatmentView): readonly IndexedEvent[] {
  const transactionId = view.commit?.record.provider_transaction_id;
  if (transactionId === undefined) {
    return [];
  }
  return view.attempt_events.filter((event) => eventString(event, 'provider_transaction_id') === transactionId);
}

function outcomeReason(view: TreatmentView): StructuredReason {
  const caller = view.journals.caller;
  if (caller.ref === undefined) {
    return incompleteArtifactReason(caller, CONDITION);
  }
  const outcome = view.outcome?.record.outcome;
  const attempt = view.targeted_attempt_id ?? '(unknown)';
  const detail = `targeted attempt ${attempt} has outcome ${outcome ?? '(none)'}; expected TIMED_OUT`;
  return reasonAt(CONDITION, outcome === undefined ? 'EVENT_MISSING' : 'OUTCOME_NOT_TIMED_OUT', detail, caller.ref);
}

function expectedOf(view: TreatmentView): JsonValue {
  return {
    outcome: 'TIMED_OUT',
    caller_events_carrying_provider_transaction_id: [],
    provider_transaction_id: view.commit?.record.provider_transaction_id ?? null,
  };
}

function observedOf(view: TreatmentView, carrying: readonly IndexedEvent[]): JsonValue {
  return {
    targeted_attempt_id: view.targeted_attempt_id ?? null,
    outcome: view.outcome?.record.outcome ?? null,
    caller_events_carrying_provider_transaction_id: carrying.map((event) => event.record.event_id),
    late_transport_settlements: view.late_settlements.map((event) => event.record.settlement_kind),
  };
}
