// The rule results that mirror a validity gate (design §8.5): BR-RUA-005 mirrors G1, BR-RUA-008
// G2, INV-RUA-001 G3, and BR-RUA-025 G4a for a CONTROL trial or G4b for a treatment trial. A
// verified gate passes, an invalid gate fails, and any other value is indeterminate with the
// gate's reasons and references. BR-RUA-007 is judged per comparison, never per trial, so it is
// not applicable here (EVALUATED_IN_COMPARISON).

import type { RuleResult, ValidityGate } from '../record-contract/records/group-c/oracle_result.ts';
import type { OracleRuleId } from '../record-contract/records/group-c/vocabulary.ts';

/**
 * The rule result that mirrors one gate.
 *
 * @example
 * mirrorRule('BR-RUA-005', independentOracleGate).result; // 'pass' when G1 is verified
 */
export function mirrorRule(ruleId: OracleRuleId, gate: ValidityGate): RuleResult {
  const expected = { gate: gate.gate, value: 'verified' };
  const observed = { gate: gate.gate, value: gate.value };
  if (gate.value === 'verified' || gate.value === 'invalid') {
    return {
      rule_id: ruleId,
      result: gate.value === 'verified' ? 'pass' : 'fail',
      expected,
      observed,
      evidence_refs: gate.evidence_refs,
      indeterminate_reasons: [],
    };
  }
  return {
    rule_id: ruleId,
    result: 'indeterminate',
    expected,
    observed,
    evidence_refs: gate.evidence_refs,
    indeterminate_reasons: gate.reasons,
  };
}

/**
 * BR-RUA-007 for one trial: equal treatment is judged by the study comparison.
 *
 * @example
 * equalTreatmentRule().result; // 'not_applicable'
 */
export function equalTreatmentRule(): RuleResult {
  return {
    rule_id: 'BR-RUA-007',
    result: 'not_applicable',
    expected: { evaluated_in: 'comparison' },
    observed: { code: 'EVALUATED_IN_COMPARISON' },
    evidence_refs: [],
    indeterminate_reasons: [],
  };
}
