// Event envelope helpers (BR-RUA-033) and the shared value helpers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EVENT_SOURCES,
  causationIds,
  executionIdentityFields,
  isCanonicalCausation,
} from '../../../src/record-contract/envelope.ts';
import { describeJson, isJsonArray, isJsonObject } from '../../../src/record-contract/json-value.ts';
import {
  EXECUTION_KINDS,
  GATE_VALUES,
  RULE_OUTCOMES,
  SCENARIOS,
  VARIANT_IDS,
  err,
  ok,
} from '../../../src/record-contract/primitives.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

const A = '10000000-0000-4000-8000-000000000000' as Uuid4;
const B = '20000000-0000-4000-8000-000000000000' as Uuid4;
const C = '30000000-0000-4000-8000-000000000000' as Uuid4;

describe('execution identity fields', () => {
  it('projects each execution kind onto its single envelope field', () => {
    assert.deepEqual(executionIdentityFields({ execution_kind: 'RUN', run_id: A }), { run_id: A });
    assert.deepEqual(executionIdentityFields({ execution_kind: 'TRANSPORT_PROBE', transport_probe_id: B }), {
      transport_probe_id: B,
    });
    assert.deepEqual(executionIdentityFields({ execution_kind: 'VARIANT_VALIDATION', variant_validation_id: C }), {
      variant_validation_id: C,
    });
  });
});

describe('causation ids', () => {
  it('omits causation for a causal root', () => {
    assert.equal(causationIds([]), undefined);
  });

  it('sorts and deduplicates predecessors', () => {
    assert.deepEqual(causationIds([C, A, B, A]), [A, B, C]);
    assert.deepEqual(causationIds([B]), [B]);
  });

  it('recognizes only non-empty strictly increasing lists', () => {
    assert.equal(isCanonicalCausation([A, B, C]), true);
    assert.equal(isCanonicalCausation([A]), true);
    assert.equal(isCanonicalCausation([]), false);
    assert.equal(isCanonicalCausation([B, A]), false);
    assert.equal(isCanonicalCausation([A, A]), false);
    assert.equal(isCanonicalCausation([A, C, B]), false);
  });

  it('is total over parsed JSON: a non-string id is never canonical (A-02 audit regression)', () => {
    const hostile: unknown = JSON.parse('{"toString":1,"valueOf":1}');
    assert.equal(isCanonicalCausation([hostile]), false);
    assert.equal(isCanonicalCausation([A, hostile]), false);
    assert.equal(isCanonicalCausation([hostile, A]), false);
    assert.equal(isCanonicalCausation([Object.create(null) as unknown, A]), false);
    assert.equal(isCanonicalCausation([A, 1, B]), false);
    assert.equal(isCanonicalCausation([null]), false);
  });
});

describe('closed vocabularies', () => {
  it('lists the event sources and study enumerations of the spec', () => {
    assert.equal(EVENT_SOURCES.length, 9);
    assert.ok(EVENT_SOURCES.includes('treatment_controller'));
    assert.deepEqual(EXECUTION_KINDS, ['RUN', 'TRANSPORT_PROBE', 'VARIANT_VALIDATION']);
    assert.deepEqual(VARIANT_IDS, ['conventional', 'durable']);
    assert.deepEqual(SCENARIOS, ['CONTROL', 'COMMIT_THEN_TIMEOUT']);
    assert.deepEqual(GATE_VALUES, ['verified', 'invalid', 'unverified', 'not_applicable']);
    assert.deepEqual(RULE_OUTCOMES, ['pass', 'fail', 'indeterminate', 'not_applicable']);
  });
});

describe('result and JSON helpers', () => {
  it('builds results', () => {
    assert.deepEqual(ok(42), { ok: true, value: 42 });
    assert.deepEqual(err('no'), { ok: false, error: 'no' });
  });

  it('narrows JSON objects only', () => {
    assert.equal(isJsonObject({}), true);
    for (const value of [[], null, 'x', 1, true, undefined]) {
      assert.equal(isJsonObject(value), false, describeJson(value));
    }
  });

  it('narrows JSON arrays only', () => {
    assert.equal(isJsonArray([]), true);
    assert.equal(isJsonArray([1, 'a']), true);
    for (const value of [{}, null, 'x', 1, undefined]) {
      assert.equal(isJsonArray(value), false, describeJson(value));
    }
  });

  it('describes JSON values with their type for error messages', () => {
    assert.equal(describeJson(undefined), 'absent');
    assert.equal(describeJson(null), 'null null');
    assert.equal(describeJson([1]), 'array [1]');
    assert.equal(describeJson({ a: 'b' }), 'object {"a":"b"}');
    assert.equal(describeJson('x'), 'string "x"');
    assert.equal(describeJson(2), 'number 2');
    assert.equal(describeJson(false), 'boolean false');
  });
});
