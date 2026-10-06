// BR-RUA-004 unknown outcome, as D-03 and design §8.5 define it. It applies when at least one
// attempt is ambiguous (`classifyOutcome` over `classifyDispatch`; an attempt dispatched or of
// unknown dispatch without an outcome counts as ambiguous, BR-RUA-021). Every request state the
// caller recorded at or after the first ambiguous outcome must say UNKNOWN, which is absorbing
// ("UNKNOWN + any later attempt outcome -> UNKNOWN"): the covered states are the first state whose
// `attempt_ids` names an ambiguous attempt and every state of a later version, whichever attempts
// those later states name. Checks, in order:
//   - the caller journal is absent or gapped: indeterminate (the ambiguity cannot be judged);
//   - no ambiguous attempt: not applicable;
//   - a covered state is not UNKNOWN: fail;
//   - an ambiguous attempt has no outcome or contradicts its dispatch evidence, the request-state
//     versions are not dense 1..n, or no state covers an ambiguous attempt: indeterminate;
//   - otherwise pass.

import { eventRef, reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { RuleResult } from '../record-contract/records/group-c/oracle_result.ts';
import { canonicalRefs } from '../treatment-fidelity/condition-result.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import { eventsOfType, isCallerEvent, partitionEvents } from '../treatment-fidelity/subject-events.ts';
import type { EventOf } from '../treatment-fidelity/subject-events.ts';
import type { AttemptFacts } from './attempt-facts.ts';
import { withCaller } from './journal-rule-refs.ts';

const RULE_ID = 'BR-RUA-004';

type RequestState = EventOf<'request_state_recorded'>;

/**
 * Evaluates BR-RUA-004 over the trial's attempts and recorded request states.
 *
 * @example
 * evaluateUnknownOutcome(evidence, readAttempts(evidence)).result; // 'pass' after a TIMED_OUT then UNKNOWN
 */
export function evaluateUnknownOutcome(evidence: IngestedEvidence, attempts: readonly AttemptFacts[]): RuleResult {
  const caller = subjectArtifactState(evidence, 'caller_journal');
  const ambiguous = attempts.filter((attempt) => attempt.outcome_class === 'AMBIGUOUS');
  const ambiguousIds = new Set<string>(ambiguous.map((attempt) => attempt.registered.record.attempt_id));
  const states = eventsOfType(partitionEvents(evidence), 'request_state_recorded')
    .filter(isCallerEvent)
    .toSorted((a, b) => a.record.version - b.record.version);
  const first = states.find((state) => state.record.attempt_ids.some((id) => ambiguousIds.has(id)));
  // A later state that names only a later attempt is still after the ambiguity, so it is covered.
  const covered = first === undefined ? [] : states.filter((state) => state.record.version >= first.record.version);
  const expected = {
    first_ambiguous_attempt_id: ambiguous[0]?.registered.record.attempt_id ?? null,
    effect_knowledge: 'UNKNOWN',
  };
  const observed = {
    recorded: covered.map((state) => ({
      version: state.record.version,
      effect_knowledge: state.record.effect_knowledge,
    })),
  };
  const refs = canonicalRefs([...ambiguous.map(attemptRef), ...covered.map(eventRef)]);
  const result = (
    outcome: RuleResult['result'],
    reasons: readonly StructuredReason[],
    seen: JsonValue = observed,
  ): RuleResult => ({
    rule_id: RULE_ID,
    result: outcome,
    expected,
    observed: seen,
    evidence_refs: refs,
    indeterminate_reasons: reasons,
  });
  if (!caller.complete) {
    // A gapped journal is cited, so the result never rests on nothing it can name.
    return {
      ...result('indeterminate', [incompleteArtifactReason(caller, RULE_ID)]),
      evidence_refs: withCaller(refs, caller.ref),
    };
  }
  if (ambiguous.length === 0) {
    return result('not_applicable', [], { code: 'NO_AMBIGUOUS_OUTCOME', recorded: [] });
  }
  if (covered.some((state) => state.record.effect_knowledge !== 'UNKNOWN')) {
    return result('fail', []);
  }
  const reasons = [...uncheckableAttemptReasons(ambiguous), ...stateReasons(states, covered, caller.ref)];
  return reasons.length === 0 ? result('pass', []) : result('indeterminate', reasons);
}

function attemptRef(attempt: AttemptFacts): EvidenceRef {
  return eventRef(attempt.outcome ?? attempt.registered);
}

// An ambiguous attempt whose outcome is missing, or contradicts its dispatch, cannot be checked.
function uncheckableAttemptReasons(ambiguous: readonly AttemptFacts[]): readonly StructuredReason[] {
  return ambiguous.flatMap((attempt) => {
    if (attempt.contradiction !== undefined) {
      return [reasonAt(RULE_ID, attempt.contradiction.code, attempt.contradiction.detail, attemptRef(attempt))];
    }
    if (attempt.outcome !== undefined) {
      return [];
    }
    const detail = `attempt ${attempt.registered.record.attempt_id} has dispatch state ${attempt.dispatch_state} and no recorded outcome; expected an outcome whose recording can be checked`;
    return [reasonAt(RULE_ID, 'OUTCOME_MISSING', detail, eventRef(attempt.registered))];
  });
}

function stateReasons(
  states: readonly RequestState[],
  covered: readonly RequestState[],
  callerRef: EvidenceRef | undefined,
): readonly StructuredReason[] {
  const versions = states.map((state) => state.record.version);
  const dense = versions.every((version, index) => version === index + 1);
  return [
    ...(dense
      ? []
      : [
          reasonAt(
            RULE_ID,
            'REQUEST_STATE_VERSIONS_NOT_DENSE',
            `request-state versions are ${boundedText(versions.join(', '))}; expected 1..${String(versions.length)} without gaps or repeats`,
            callerRef,
          ),
        ]),
    ...(covered.length > 0
      ? []
      : [
          reasonAt(
            RULE_ID,
            'REQUEST_STATE_NOT_RECORDED',
            'no request state names an ambiguous attempt; expected the knowledge recorded after the first ambiguous outcome',
            callerRef,
          ),
        ]),
  ];
}
