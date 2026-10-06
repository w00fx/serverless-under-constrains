// The rule ids the trial oracle's verdict rests on (design §5.3 `trial-oracle/`, §8.6). The five
// business rules decide a valid trial's verdict (BR-RUA-006); the verdict-changing ids add every
// validity gate (G1-G8, G4 split into G4a and G4b) and the derivations BR-RUA-006, BR-RUA-029 and
// BR-RUA-030, and are what the AC-RUA-055 coverage golden requires a passing case for.

import { GATE_IDS } from '../record-contract/records/group-c/vocabulary.ts';
import type { GateId, OracleRuleId } from '../record-contract/records/group-c/vocabulary.ts';

/** BR-RUA-006: the business rules whose outcomes decide a valid trial's verdict. */
export const VERDICT_BUSINESS_RULES = [
  'BR-RUA-001',
  'BR-RUA-002',
  'BR-RUA-003',
  'BR-RUA-004',
  'BR-RUA-009',
] as const satisfies readonly OracleRuleId[];
export type VerdictBusinessRuleId = (typeof VERDICT_BUSINESS_RULES)[number];

/** The derivations that turn gates and rules into the verdict, validity and completion. */
export const VERDICT_DERIVATION_RULES = ['BR-RUA-006', 'BR-RUA-029', 'BR-RUA-030'] as const;

/** Every id whose outcome can change a trial's verdict. */
export type VerdictChangingRuleId = GateId | VerdictBusinessRuleId | (typeof VERDICT_DERIVATION_RULES)[number];

/**
 * The verdict-changing ids in a fixed order: gates, business rules, derivations.
 *
 * @example
 * VERDICT_CHANGING_RULES.includes('settlement'); // true
 */
export const VERDICT_CHANGING_RULES: readonly VerdictChangingRuleId[] = [
  ...GATE_IDS,
  ...VERDICT_BUSINESS_RULES,
  ...VERDICT_DERIVATION_RULES,
];

/**
 * Whether a rule id is one of the BR-RUA-006 business rules.
 *
 * @example
 * isVerdictBusinessRule('BR-RUA-005'); // false: a mirror of G1, never a verdict input
 */
export function isVerdictBusinessRule(ruleId: OracleRuleId): ruleId is VerdictBusinessRuleId {
  return (VERDICT_BUSINESS_RULES as readonly OracleRuleId[]).includes(ruleId);
}
