// The oracle's evaluation of a built trial, for suites that need a whole result: the build is
// ingested with the real validator and evaluated with a fixed `checked_at`; a refusal throws, which
// fails the calling test.

import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { evaluateTrial } from '../../../../src/trial-oracle/evaluate-trial.ts';
import type { TrialEvaluation } from '../../../../src/trial-oracle/evaluate-trial.ts';
import { builtEvidence } from './built-trials.ts';
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
