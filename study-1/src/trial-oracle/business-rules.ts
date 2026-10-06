// The ten `rule_results[]` of an oracle result in their fixed order (design §6.3, §8.5): the
// monetary rules BR-RUA-001, -002 and -009 on the D-15 basis, the journal rules BR-RUA-003 and
// -004 over the caller's attempts, the gate mirrors BR-RUA-005, -008, INV-RUA-001 and BR-RUA-025,
// and BR-RUA-007, which is judged per comparison. The monetary observations come with them.

import type { IngestedEvidence } from '../evidence-ingestion/ingestion-model.ts';
import type { MonetaryObservations, RuleResult } from '../record-contract/records/group-c/oracle_result.ts';
import type { AttemptFacts } from './attempt-facts.ts';
import { evaluateLogicalIdentity } from './logical-identity-rule.ts';
import type { MonetaryBasis } from './monetary-basis.ts';
import { evaluateMonetaryRules } from './monetary-rules.ts';
import { equalTreatmentRule, mirrorRule } from './mirror-rules.ts';
import type { BusinessInputs } from './oracle-inputs.ts';
import { evaluateUnknownOutcome } from './unknown-outcome-rule.ts';
import type { NineGates } from './validity-gates.ts';

export type TenRules = readonly [
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
  RuleResult,
];

/** What the rules read besides the evidence. */
export interface RuleInputs {
  readonly basis: MonetaryBasis;
  readonly gates: NineGates;
  readonly inputs: BusinessInputs;
  readonly attempts: readonly AttemptFacts[];
}

export interface BusinessRuleResults {
  readonly rules: TenRules;
  readonly monetary_observations: MonetaryObservations;
}

/**
 * Evaluates every rule of the oracle result, in its fixed order.
 *
 * @example
 * evaluateBusinessRules(evidence, ruleInputs).rules.map((rule) => rule.rule_id); // ORACLE_RULE_IDS
 */
export function evaluateBusinessRules(evidence: IngestedEvidence, rule: RuleInputs): BusinessRuleResults {
  const [oracle, traceability, identity, control, fidelity] = rule.gates;
  const monetary = evaluateMonetaryRules(evidence, rule.inputs, rule.basis);
  const scenarioGate = control.value === 'not_applicable' ? fidelity : control;
  return {
    rules: [
      monetary.one_effect,
      monetary.payment_limit,
      evaluateLogicalIdentity(evidence, rule.attempts, rule.inputs, identity.value),
      evaluateUnknownOutcome(evidence, rule.attempts),
      mirrorRule('BR-RUA-005', oracle),
      equalTreatmentRule(),
      mirrorRule('BR-RUA-008', traceability),
      monetary.exact_effect,
      mirrorRule('INV-RUA-001', identity),
      mirrorRule('BR-RUA-025', scenarioGate),
    ],
    monetary_observations: monetary.observations,
  };
}
