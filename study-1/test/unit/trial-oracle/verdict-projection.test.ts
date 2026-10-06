// The D-16 verdict projection: exactly the verdict, validity, gate values, rule outcomes and
// correct completion of a result, so late evidence compares on those members alone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verdictProjection } from '../../../src/trial-oracle/verdict-projection.ts';
import { evaluatedTrial } from './support/evaluated-trials.ts';

describe('verdictProjection', () => {
  it('keeps the verdict, validity, every gate value, every rule outcome and the completion', () => {
    const { result } = evaluatedTrial({ base: 'run-conventional-control' });
    assert.deepEqual(verdictProjection(result), {
      preservation_verdict: 'pass',
      trial_validity: 'valid',
      gates: result.validity_gates.map((gate) => ({ gate: gate.gate, value: gate.value })),
      rules: result.rule_results.map((rule) => ({ rule_id: rule.rule_id, result: rule.result })),
      correct_completion: true,
    });
  });

  it('is equal for results that differ only outside the projection', () => {
    const { result } = evaluatedTrial({ base: 'run-conventional-control' });
    const rechecked = {
      ...result,
      checked_at: '2026-10-05T14:00:00.000Z' as typeof result.checked_at,
      indeterminate_reasons: [],
    };
    assert.deepEqual(verdictProjection(rechecked), verdictProjection(result));
  });

  it('differs when a gate value differs', () => {
    const { result } = evaluatedTrial({ base: 'run-conventional-control' });
    const [first, ...rest] = result.validity_gates;
    const changed = {
      ...result,
      validity_gates: [{ ...first, value: 'unverified' as const }, ...rest] as unknown as typeof result.validity_gates,
    };
    assert.notDeepEqual(verdictProjection(changed), verdictProjection(result));
  });
});
