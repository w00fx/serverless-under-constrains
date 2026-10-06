// BR-RUA-010 commit before timer (design §8.10, D-24): `K′.committed_at < Θ.timer_fired_at`, an
// empirical cross-source wall-clock ordering under CA-1, never a happened-before proof (AC-RUA-002).
// Reversed timestamps fail; equal or missing timestamps are indeterminate. With Θ present, a
// complete provider journal and a complete ledger that hold no commit of T fail the condition: the
// provider never committed. `observed` always reports both signed differences, from `committed_at`
// and from the diagnostic `commit_requested_at`; neither is a clock-error bound.

import { reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import { signedDifferenceMs } from '../record-contract/decimal.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import type { ConditionResult } from '../record-contract/records/group-c/shared-shapes.ts';
import { isUtcMillis } from '../record-contract/timestamps.ts';
import { finishCondition, idOf, refOf } from './condition-result.ts';
import type { ConditionDraft } from './condition-result.ts';
import { incompleteArtifactReason } from './subject-artifacts.ts';
import type { TreatmentView } from './treatment-view.ts';

const CONDITION = 'BR-RUA-010';

const EXPECTED: JsonValue = {
  relation: 'provider_commit_confirmed.committed_at < caller_timeout_recorded.timer_fired_at',
  ordering_basis: 'cross_source_wall_clock',
  clock_assumption_refs: ['CA-1'],
};

/**
 * Judges BR-RUA-010 over the treatment view.
 *
 * @example
 * evaluateCommitBeforeTimer(view).result; // 'pass' when committed_at precedes timer_fired_at
 */
export function evaluateCommitBeforeTimer(view: TreatmentView): ConditionResult {
  return finishCondition(CONDITION, draftOf(view), view.findings);
}

function draftOf(view: TreatmentView): ConditionDraft {
  const difference = differenceMs(view.caller_timeout?.record.timer_fired_at, view.confirmation?.record.committed_at);
  const observed = observedOf(view);
  const refs = [refOf(view.commit), refOf(view.confirmation), refOf(view.caller_timeout)];
  if (difference !== undefined) {
    return orderingDraft(difference, observed, refs);
  }
  if (view.caller_timeout !== undefined && provenNoCommit(view)) {
    return {
      result: 'fail',
      expected: EXPECTED,
      observed,
      refs: [...refs, view.journals.provider.ref, view.ledger_state.ref],
      reasons: [],
    };
  }
  return {
    result: 'indeterminate',
    expected: EXPECTED,
    observed,
    refs: [...refs, view.journals.provider.ref, view.journals.caller.ref],
    reasons: missingReasons(view),
  };
}

function orderingDraft(timerMinusCommit: string, observed: JsonValue, refs: ConditionDraft['refs']): ConditionDraft {
  if (timerMinusCommit === '0') {
    const detail = 'committed_at equals timer_fired_at; expected committed_at < timer_fired_at';
    return {
      result: 'indeterminate',
      expected: EXPECTED,
      observed,
      refs,
      reasons: [reasonAt(CONDITION, 'EQUAL_TIMESTAMPS', detail, refs[1])],
    };
  }
  const reversed = timerMinusCommit.startsWith('-');
  return { result: reversed ? 'fail' : 'pass', expected: EXPECTED, observed, refs, reasons: [] };
}

// "No commit exists" is conclusive only over complete evidence: no commit event of T in a complete
// provider journal, and no transaction of T in a complete, usable ledger.
function provenNoCommit(view: TreatmentView): boolean {
  const attemptId = view.targeted_attempt_id;
  if (attemptId === undefined || view.targeted_commits.length > 0 || !view.journals.provider.complete) {
    return false;
  }
  const ledger = view.ledger;
  const ledgerComplete =
    ledger.status === 'present' && ledger.pagination_complete && ledger.duplicate_transaction_ids.length === 0;
  return (
    ledgerComplete &&
    !view.commits.some((event) => event.record.attempt_id === attemptId) &&
    !ledger.transactions.some((transaction) => transaction.attempt_id === attemptId)
  );
}

function missingReasons(view: TreatmentView): ConditionDraft['reasons'] {
  const reasons = [];
  if (view.confirmation === undefined) {
    reasons.push(
      view.journals.provider.ref === undefined
        ? incompleteArtifactReason(view.journals.provider, CONDITION)
        : reasonAt(
            CONDITION,
            view.targeted_commits.length > 1 ? 'TARGETED_COMMIT_AMBIGUOUS' : 'EVENT_MISSING',
            `${String(view.targeted_commits.length)} targeted commit(s) and no provider_commit_confirmed for the targeted commit; expected exactly one confirmed targeted commit`,
            view.journals.provider.ref,
          ),
    );
  }
  if (view.caller_timeout === undefined) {
    reasons.push(
      view.journals.caller.ref === undefined
        ? incompleteArtifactReason(view.journals.caller, CONDITION)
        : reasonAt(
            CONDITION,
            'EVENT_MISSING',
            `no caller_timeout_recorded for targeted attempt ${view.targeted_attempt_id ?? '(unknown)'}; expected the timer's event`,
            view.journals.caller.ref,
          ),
    );
  }
  return reasons;
}

function observedOf(view: TreatmentView): JsonValue {
  const committedAt = view.confirmation?.record.committed_at;
  const requestedAt = view.commit?.record.commit_requested_at;
  const timerFiredAt = view.caller_timeout?.record.timer_fired_at;
  return {
    committed_at: committedAt ?? null,
    commit_requested_at: requestedAt ?? null,
    timer_fired_at: timerFiredAt ?? null,
    timer_minus_committed_ms: differenceMs(timerFiredAt, committedAt) ?? null,
    timer_minus_commit_requested_ms: differenceMs(timerFiredAt, requestedAt) ?? null,
    commit_event_id: idOf(view.commit),
    confirmation_event_id: idOf(view.confirmation),
    caller_timeout_event_id: idOf(view.caller_timeout),
    targeted_commit_count: view.targeted_commits.length,
  };
}

// Ingestion proved both timestamps' shape; the guard keeps the comparison total anyway (A-05).
function differenceMs(later: string | undefined, earlier: string | undefined): string | undefined {
  return isUtcMillis(later) && isUtcMillis(earlier) ? signedDifferenceMs(later, earlier) : undefined;
}
