// BR-RUA-003 stable logical identity (design §8.5, AC-RUA-039): every registered attempt carries
// the approved decision's `refund_request_id` R. Applicable with at least one attempt; without one
// it is not applicable (NO_ATTEMPTS) once the caller journal is known complete. It fails when any
// attempt carries another id; it is indeterminate when the caller journal is absent or gapped, the
// decision is missing, or identity integrity (G3) is unverified, since an unregistered attempt
// could carry any id.

import { eventRef, reasonAt } from '../evidence-ingestion/gate-assessment.ts';
import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { EvidenceRef } from '../record-contract/evidence-refs.ts';
import type { GateValue, JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { RuleResult } from '../record-contract/records/group-c/oracle_result.ts';
import { canonicalRefs } from '../treatment-fidelity/condition-result.ts';
import { incompleteArtifactReason, subjectArtifactState } from '../treatment-fidelity/subject-artifacts.ts';
import type { AttemptFacts } from './attempt-facts.ts';
import { withCaller } from './journal-rule-refs.ts';
import { inputMissingReason } from './oracle-inputs.ts';
import type { BusinessInputs } from './oracle-inputs.ts';

const RULE_ID = 'BR-RUA-003';

/**
 * Evaluates BR-RUA-003 over the trial's attempts.
 *
 * @example
 * evaluateLogicalIdentity(evidence, readAttempts(evidence), businessInputs(evidence), 'verified').result; // 'pass'
 */
export function evaluateLogicalIdentity(
  evidence: IngestedEvidence,
  attempts: readonly AttemptFacts[],
  inputs: BusinessInputs,
  identityIntegrity: GateValue,
): RuleResult {
  const expectedId = inputs.decision.record?.refund_request_id ?? null;
  const ids = [...new Set(attempts.map((attempt) => attempt.registered.record.refund_request_id))].toSorted();
  const expected = { refund_request_ids: [expectedId] };
  const refs = canonicalRefs([
    ...attempts.map((attempt) => eventRef(attempt.registered)),
    ...(inputs.decision.ref === undefined ? [] : [inputs.decision.ref]),
  ]);
  const caller = subjectArtifactState(evidence, 'caller_journal');
  const indeterminate = (reason: StructuredReason): RuleResult =>
    ruleResult('indeterminate', expected, { refund_request_ids: ids }, refs, [reason]);
  if (!caller.complete) {
    const reason = incompleteArtifactReason(caller, RULE_ID);
    return { ...indeterminate(reason), evidence_refs: withCaller(refs, caller.ref) };
  }
  if (attempts.length === 0) {
    return ruleResult('not_applicable', expected, { code: 'NO_ATTEMPTS', refund_request_ids: [] }, refs, []);
  }
  if (expectedId === null) {
    return indeterminate(inputMissingReason(inputs.decision, RULE_ID));
  }
  const other = attempts.find((attempt) => attempt.registered.record.refund_request_id !== expectedId);
  if (other !== undefined) {
    return ruleResult('fail', expected, { refund_request_ids: ids }, refs, []);
  }
  if (identityIntegrity === 'unverified') {
    const detail =
      'identity integrity (G3) is unverified, so an unregistered attempt may carry another refund_request_id; expected verified identity evidence';
    return indeterminate(reasonAt(RULE_ID, 'IDENTITY_EVIDENCE_UNVERIFIED', detail, caller.ref));
  }
  return ruleResult('pass', expected, { refund_request_ids: ids }, refs, []);
}

function ruleResult(
  result: RuleResult['result'],
  expected: JsonValue,
  observed: JsonValue,
  refs: readonly EvidenceRef[],
  reasons: readonly StructuredReason[],
): RuleResult {
  return { rule_id: RULE_ID, result, expected, observed, evidence_refs: refs, indeterminate_reasons: reasons };
}
