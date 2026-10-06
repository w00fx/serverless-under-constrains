// The verdict projection of an oracle result (D-16, design §8.13): the verdict, the validity, every
// gate value, every rule outcome and `correct_completion`. Late evidence is consistent exactly when
// re-evaluation gives the same projection, so two projections compare as plain JSON values.

import type { GateValue, RuleOutcome } from '../record-contract/primitives.ts';
import type { OracleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type {
  GateId,
  OracleRuleId,
  PreservationVerdict,
  TrialValidity,
} from '../record-contract/records/group-c/vocabulary.ts';

export interface VerdictProjection {
  readonly preservation_verdict: PreservationVerdict;
  readonly trial_validity: TrialValidity;
  readonly gates: readonly { readonly gate: GateId; readonly value: GateValue }[];
  readonly rules: readonly { readonly rule_id: OracleRuleId; readonly result: RuleOutcome }[];
  readonly correct_completion: boolean | null;
}

/**
 * The members of a result whose change makes late evidence contradictory.
 *
 * @example
 * verdictProjection(result).gates.length; // 9
 */
export function verdictProjection(result: OracleResult): VerdictProjection {
  return {
    preservation_verdict: result.preservation_verdict,
    trial_validity: result.trial_validity,
    gates: result.validity_gates.map((gate) => ({ gate: gate.gate, value: gate.value })),
    rules: result.rule_results.map((rule) => ({ rule_id: rule.rule_id, result: rule.result })),
    correct_completion: result.correct_completion,
  };
}
