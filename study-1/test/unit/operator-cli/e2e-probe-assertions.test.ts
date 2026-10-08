// The AC-RUA-002 and AC-RUA-021 e2e result checks, offline (WP-28 review F3): they accept the
// golden passing probe's frozen result (the same fixture the golden halves derive from, built by
// the real ingestion and probe-result code) and reject every one-member departure from it, so the
// real-cloud driver cannot pass on a result that misses a member the spec names.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  TRANSPORT_CONDITION_IDS,
  assertCommitBeforeTimerResult,
  assertQualificationPassResult,
} from '../../e2e/support/probe-result-assertions.ts';
import { frozenProbeResult, loadProbeCase } from '../../golden/transport-qualification/verdict/support/probe-golden.ts';

type Departure = readonly [name: string, depart: (result: JsonObject) => JsonObject];

async function goldenResult(caseId: string): Promise<JsonObject> {
  const loaded = await loadProbeCase(caseId);
  return frozenProbeResult(loaded.files) as unknown as JsonObject;
}

function conditionsOf(result: JsonObject): readonly JsonObject[] {
  return result['condition_results'] as readonly JsonObject[];
}

function withMember(member: string, value: JsonValue): Departure[1] {
  return (result) => ({ ...result, [member]: value });
}

function withConditions(change: (conditions: readonly JsonObject[]) => readonly JsonValue[]): Departure[1] {
  return (result) => ({ ...result, condition_results: change(conditionsOf(result)) });
}

function withCondition(id: string, change: (condition: JsonObject) => JsonObject): Departure[1] {
  return withConditions((conditions) =>
    conditions.map((condition) => (condition['condition_id'] === id ? change(condition) : condition)),
  );
}

function assertRejectsEach(
  check: (result: JsonObject) => void,
  result: JsonObject,
  departures: readonly Departure[],
): void {
  for (const [name, depart] of departures) {
    assert.throws(
      () => {
        check(depart(result));
      },
      assert.AssertionError,
      name,
    );
  }
}

describe('assertCommitBeforeTimerResult (ac002-real-probe)', () => {
  it('accepts the golden commit-before-timer probe result', async () => {
    const result = await goldenResult('ac002-condition-derivation');
    assert.deepEqual(
      conditionsOf(result).map((condition) => condition['condition_id']),
      TRANSPORT_CONDITION_IDS,
    );
    assert.doesNotThrow(() => {
      assertCommitBeforeTimerResult(result);
    });
  });

  it('rejects each departure from the spec-named members', async () => {
    const result = await goldenResult('ac002-condition-derivation');
    assertRejectsEach(assertCommitBeforeTimerResult, result, [
      ['no condition array', withMember('condition_results', {})],
      ['a condition that is no object', withConditions(() => ['BR-RUA-010'])],
      ['conditions out of order', withConditions((conditions) => conditions.toReversed())],
      ['a missing condition', withConditions((conditions) => conditions.slice(1))],
      ['a failing condition', withCondition('BR-RUA-012', (condition) => ({ ...condition, result: 'fail' }))],
      [
        'a condition without evidence',
        withCondition('BR-RUA-010', (condition) => ({ ...condition, evidence_refs: [] })),
      ],
      ['unverified fidelity', withMember('treatment_fidelity', 'unverified')],
      ['another fidelity basis', withMember('fidelity_basis', 'causal_only')],
      ['no clock assumption', withMember('clock_assumption_refs', [])],
      ['another ordering basis', withMember('ordering_basis', 'causal')],
      [
        'a nested happened-before claim',
        withCondition('BR-RUA-010', (condition) => ({ ...condition, observed: { happened_before: true } })),
      ],
      ['a top-level proof claim', withMember('ordering_proof', true)],
    ]);
  });
});

describe('assertQualificationPassResult (ac021-real-probe-pass)', () => {
  it('accepts the golden passing probe result', async () => {
    const result = await goldenResult('ac021-probe-verdict-pass');
    assert.doesNotThrow(() => {
      assertQualificationPassResult(result);
    });
  });

  it('rejects each unmet antecedent of a pass', async () => {
    const result = await goldenResult('ac021-probe-verdict-pass');
    const release = (observed: JsonValue): Departure[1] =>
      withCondition('BR-RUA-014', (condition) => ({ ...condition, observed }));
    assertRejectsEach(assertQualificationPassResult, result, [
      ['another verdict', withMember('transport_probe_verdict', 'fail')],
      [
        'an indeterminate condition',
        withCondition('BR-RUA-013', (condition) => ({ ...condition, result: 'indeterminate' })),
      ],
      [
        'no controlled-release condition',
        withConditions((conditions) => conditions.filter((condition) => condition['condition_id'] !== 'BR-RUA-014')),
      ],
      ['invalid probe fidelity', withMember('probe_validity', 'invalid')],
      ['unverified treatment fidelity', withMember('treatment_fidelity', 'unverified')],
      ['unverified evidence', withMember('evidence_integrity', 'unverified')],
      [
        'a second accepted provider call',
        withMember('probe_cardinality', {
          caller_invocations: 1,
          accepted_provider_calls: 2,
          committed_transactions: 1,
        }),
      ],
      ['a safety release', release({ safety_release_count: 1 })],
      ['no release observation', release(null)],
    ]);
  });
});
