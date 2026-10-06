// The oracle's evaluation of a built trial, for suites that need a whole result: the build is
// ingested with the real validator and evaluated with a fixed `checked_at`; a refusal throws, which
// fails the calling test.

import { validateResultReferences } from '../../../../src/record-contract/evidence-refs.ts';
import type { JsonValue, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { evaluateTrial } from '../../../../src/trial-oracle/evaluate-trial.ts';
import type { TrialEvaluation } from '../../../../src/trial-oracle/evaluate-trial.ts';
import { builtEvidence, ORACLE_VALIDATOR } from './built-trials.ts';
import type { TrialBuild } from './built-trials.ts';

/** The instant the unit suites check trials at. */
export const UNIT_CHECKED_AT = '2026-10-05T13:30:00.000Z' as UtcMillis;

/**
 * Evaluates a built trial.
 *
 * @example
 * evaluatedTrial({ base: 'run-conventional-control' }).result.preservation_verdict; // 'pass'
 */
export function evaluatedTrial(build: TrialBuild): TrialEvaluation {
  const evaluated = evaluateTrial({ evidence: builtEvidence(build), checked_at: UNIT_CHECKED_AT });
  if (!evaluated.ok) {
    throw new Error(`${JSON.stringify(build)} was refused: ${JSON.stringify(evaluated.error)}; expected a result`);
  }
  return evaluated.value;
}

/**
 * Every contract an evaluation breaks: the result's and the projection's schemas (CTR-RUA-001)
 * and, for each judged rule, BR-RUA-035's reference requirements. Empty when it holds them all.
 *
 * @example
 * evaluationContractProblems(evaluatedTrial({ base: 'run-durable-control' })); // []
 */
export function evaluationContractProblems(evaluation: TrialEvaluation): readonly string[] {
  const { result, projection } = evaluation;
  const resultCheck = ORACLE_VALIDATOR.validateAs('oracle_result', result as unknown as JsonValue);
  const projectionCheck = ORACLE_VALIDATOR.validateAs('attempt_projection', projection as unknown as JsonValue);
  return [
    ...(resultCheck.valid ? [] : [JSON.stringify(resultCheck.violations)]),
    ...(projectionCheck.valid ? [] : [JSON.stringify(projectionCheck.violations)]),
    ...result.rule_results.flatMap((rule) =>
      rule.result === 'not_applicable'
        ? []
        : validateResultReferences(rule.result, rule.evidence_refs, rule.indeterminate_reasons),
    ),
  ];
}
