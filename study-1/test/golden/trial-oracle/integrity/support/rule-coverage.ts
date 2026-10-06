// The AC-RUA-055 rule-coverage golden's model (BR-RUA-055, design D-18): every `(rule, outcome)`
// pair a verdict-changing id can reach, the pairs one trial evaluation reaches, and the pairs
// every trial-oracle golden case declares. A gate is reached with its value, a business rule with
// its result, BR-RUA-006 with the verdict, BR-RUA-029 with the validity and BR-RUA-030 with
// `correct_completion` as text; a refused evaluation reaches only BR-RUA-030 `null` (no result).

import { globSync } from 'node:fs';

import { VERDICT_CHANGING_RULES, isVerdictBusinessRule } from '../../../../../src/trial-oracle/oracle-vocabulary.ts';
import type { VerdictChangingRuleId } from '../../../../../src/trial-oracle/oracle-vocabulary.ts';
import { STUDY_ROOT } from '../../../_harness/golden-harness.ts';
import type { LoadedGoldenCase } from '../../../_harness/golden-harness.ts';
import type { IntegrityEvaluation } from './integrity-golden.ts';

const GATE_VALUES = ['verified', 'invalid', 'unverified'] as const;
const SCENARIO_GATE_VALUES = [...GATE_VALUES, 'not_applicable'] as const;
const CONCLUSIVE_RULE_RESULTS = ['pass', 'fail', 'indeterminate'] as const;
const CONDITIONAL_RULE_RESULTS = [...CONCLUSIVE_RULE_RESULTS, 'not_applicable'] as const;

/**
 * Every outcome each verdict-changing id can reach. What is left out cannot be reached:
 * - `not_applicable` for every gate but G4a and G4b: BR-RUA-029 applies G1-G3 and G5-G8 to every
 *   trial; only the scenario decides between control integrity (G4a) and treatment fidelity (G4b);
 * - `invalid` for `rule_evidence` (G7): missing or gapped rule evidence leaves a rule unverifiable,
 *   it never proves the trial wrong (design §8.3);
 * - `not_applicable` for BR-RUA-001, -002 and -009: every trial carries an approved refund whose
 *   effect the ledger must show, so the monetary rules always apply. BR-RUA-003 does not apply
 *   without an attempt and BR-RUA-004 without an ambiguous outcome.
 */
export const REACHABLE_RULE_OUTCOMES: ReadonlyMap<VerdictChangingRuleId, readonly string[]> = new Map<
  VerdictChangingRuleId,
  readonly string[]
>([
  ['independent_oracle', GATE_VALUES],
  ['traceability', GATE_VALUES],
  ['identity_integrity', GATE_VALUES],
  ['control_integrity', SCENARIO_GATE_VALUES],
  ['treatment_fidelity', SCENARIO_GATE_VALUES],
  ['ledger_access', GATE_VALUES],
  ['settlement', GATE_VALUES],
  ['rule_evidence', ['verified', 'unverified']],
  ['evidence_integrity', GATE_VALUES],
  ['BR-RUA-001', CONCLUSIVE_RULE_RESULTS],
  ['BR-RUA-002', CONCLUSIVE_RULE_RESULTS],
  ['BR-RUA-003', CONDITIONAL_RULE_RESULTS],
  ['BR-RUA-004', CONDITIONAL_RULE_RESULTS],
  ['BR-RUA-009', CONCLUSIVE_RULE_RESULTS],
  ['BR-RUA-006', ['pass', 'fail', 'indeterminate']],
  ['BR-RUA-029', ['valid', 'invalid', 'indeterminate']],
  ['BR-RUA-030', ['true', 'false', 'null']],
]);

/** Every trial-oracle golden case, root-relative and sorted. */
export const TRIAL_ORACLE_CASE_FILES: readonly string[] = globSync('test/golden/trial-oracle/**/cases/*.case.ts', {
  cwd: STUDY_ROOT,
}).toSorted();

/**
 * A `(rule, outcome)` pair as one comparable key.
 *
 * @example
 * pairKey('settlement', 'invalid'); // 'settlement=invalid'
 */
export function pairKey(ruleId: string, outcome: string): string {
  return `${ruleId}=${outcome}`;
}

/**
 * Every reachable pair, in VERDICT_CHANGING_RULES order.
 *
 * @example
 * reachablePairs().includes('BR-RUA-030=null'); // true
 */
export function reachablePairs(): readonly string[] {
  return VERDICT_CHANGING_RULES.flatMap((ruleId) =>
    (REACHABLE_RULE_OUTCOMES.get(ruleId) ?? []).map((outcome) => pairKey(ruleId, outcome)),
  );
}

/**
 * The verdict-changing pairs one evaluation reaches.
 *
 * @example
 * reachedPairs({ ok: false, error: reasons }); // ['BR-RUA-030=null']
 */
export function reachedPairs(evaluation: IntegrityEvaluation['evaluation']): readonly string[] {
  if (!evaluation.ok) {
    return [pairKey('BR-RUA-030', 'null')];
  }
  const { result } = evaluation.value;
  return [
    ...result.validity_gates.map((gate) => pairKey(gate.gate, gate.value)),
    ...result.rule_results
      .filter((rule) => isVerdictBusinessRule(rule.rule_id))
      .map((rule) => pairKey(rule.rule_id, rule.result)),
    pairKey('BR-RUA-006', result.preservation_verdict),
    pairKey('BR-RUA-029', result.trial_validity),
    pairKey('BR-RUA-030', String(result.correct_completion)),
  ];
}

/**
 * The verdict-changing pairs a case declares; pairs of other rules (such as the BR-RUA-005 mirror)
 * are not the coverage golden's concern.
 *
 * @example
 * declaredPairs(loaded); // ['treatment_fidelity=invalid', 'BR-RUA-006=indeterminate', ...]
 */
export function declaredPairs(loaded: LoadedGoldenCase): readonly string[] {
  const verdictChanging: ReadonlySet<string> = new Set(VERDICT_CHANGING_RULES);
  return loaded.golden_case.rule_outcomes_reached
    .filter((declared) => verdictChanging.has(declared.rule_id))
    .map((declared) => pairKey(declared.rule_id, declared.outcome));
}
