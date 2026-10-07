// The frozen-probe-result checks of the AC-RUA-002 and AC-RUA-021 e2e halves (design §14 rows 002
// and 021). They live apart from the driver so the offline unit suite runs them over the golden
// passing probe and over one-member departures from it (WP-28 review F3): a check that only the
// real-cloud run executes could name a member the result never carries and stay green unseen.

import assert from 'node:assert/strict';

import { isJsonArray, isJsonObject } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { HAPPENED_BEFORE_PATTERN } from '../../golden/transport-qualification/verdict/support/probe-golden.ts';

/** The six transport conditions, in the order the result schema fixes (BR-RUA-010..015). */
export const TRANSPORT_CONDITION_IDS: readonly string[] = [
  'BR-RUA-010',
  'BR-RUA-011',
  'BR-RUA-012',
  'BR-RUA-013',
  'BR-RUA-014',
  'BR-RUA-015',
];

// BR-RUA-014 controlled release: its `observed` counts the safety releases the provider made.
const CONTROLLED_RELEASE = 'BR-RUA-014';

/**
 * AC-RUA-002: "BR-RUA-010 through BR-RUA-015 are evaluated from frozen evidence", each passing on
 * evidence references; "verified fidelity identifies CA-1 and
 * `causal_plus_cross_source_clock_assumption`"; and "the result does not claim formal
 * happened-before proof or an AWS clock guarantee" (no member name says so, at any depth).
 *
 * @example
 * assertCommitBeforeTimerResult(packageRecord(directory, probeResultPath, 'transport_probe_result'));
 */
export function assertCommitBeforeTimerResult(result: JsonObject): void {
  const conditions = conditionResults(result);
  assert.deepEqual(
    conditions.map((condition) => condition['condition_id']),
    TRANSPORT_CONDITION_IDS,
  );
  for (const condition of conditions) {
    assert.equal(condition['result'], 'pass', JSON.stringify(condition));
    const refs = condition['evidence_refs'];
    assert.ok(isJsonArray(refs) && refs.length > 0, `${JSON.stringify(condition['condition_id'])} cites its evidence`);
  }
  assert.equal(result['treatment_fidelity'], 'verified');
  assert.equal(result['fidelity_basis'], 'causal_plus_cross_source_clock_assumption');
  assert.deepEqual(result['clock_assumption_refs'], ['CA-1']);
  assert.equal(result['ordering_basis'], 'cross_source_wall_clock');
  assert.deepEqual(
    memberNames(result).filter((name) => HAPPENED_BEFORE_PATTERN.test(name)),
    [],
  );
}

/**
 * AC-RUA-021: "a `pass` requires every TQ condition to pass, valid probe fidelity, verified
 * evidence, expected cardinality, and no safety release" — each antecedent is checked on its own
 * member, not inferred from the verdict.
 *
 * @example
 * assertQualificationPassResult(packageRecord(directory, probeResultPath, 'transport_probe_result'));
 */
export function assertQualificationPassResult(result: JsonObject): void {
  assert.equal(result['transport_probe_verdict'], 'pass');
  const conditions = conditionResults(result);
  assert.deepEqual(
    conditions.map((condition) => [condition['condition_id'], condition['result']]),
    TRANSPORT_CONDITION_IDS.map((id) => [id, 'pass']),
  );
  assert.equal(result['probe_validity'], 'valid');
  assert.equal(result['treatment_fidelity'], 'verified');
  assert.equal(result['evidence_integrity'], 'verified');
  assert.deepEqual(result['probe_cardinality'], {
    caller_invocations: 1,
    accepted_provider_calls: 1,
    committed_transactions: 1,
  });
  const release = conditions.find((condition) => condition['condition_id'] === CONTROLLED_RELEASE);
  const observed = release?.['observed'];
  assert.ok(isJsonObject(observed), `${CONTROLLED_RELEASE} records what it observed`);
  assert.equal(observed['safety_release_count'], 0);
}

// The condition results, each a JSON object, in the order the result lists them.
function conditionResults(result: JsonObject): readonly JsonObject[] {
  const conditions = result['condition_results'];
  assert.ok(isJsonArray(conditions), 'condition_results is an array');
  return conditions.map((condition) => {
    assert.ok(isJsonObject(condition), `a condition result is an object: ${JSON.stringify(condition)}`);
    return condition;
  });
}

// Every member name of a JSON value, at any depth.
function memberNames(value: JsonValue): readonly string[] {
  if (isJsonArray(value)) {
    return value.flatMap(memberNames);
  }
  if (!isJsonObject(value)) {
    return [];
  }
  return [...Object.keys(value), ...Object.values(value).flatMap(memberNames)];
}
