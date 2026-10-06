// The ownership tags of an execution stack (BR-RUA-050; design §9.7; D-07): each base key exactly
// once with `suc:run_id` equal to the execution id, `suc:variant_id` only once and only on a variant
// validation's stack, no other key and no empty or `@` value; after deployment the stack's observed
// `suc:*` tags must equal the declared ones.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkDeclaredTags, observedTagReasons } from '../../../src/deployment-assembly/ownership-tag-checks.ts';
import type { KeyValueEntry } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import {
  declaredTags,
  EXECUTION_ID,
  PROBE_IDENTITY,
  RUN_IDENTITY,
  VALIDATION_IDENTITY,
} from '../../support/deployment-assembly/deployment-fixtures.ts';

function codes(result: ReturnType<typeof checkDeclaredTags>): readonly string[] {
  return result.ok ? [] : result.error.map((reason) => reason.code);
}

describe('checkDeclaredTags', () => {
  it('accepts the five base tags of every kind, sorted by key', () => {
    for (const identity of [RUN_IDENTITY, PROBE_IDENTITY, VALIDATION_IDENTITY]) {
      const checked = checkDeclaredTags(identity, declaredTags());
      assert.deepEqual(checked.ok ? checked.value.map((tag) => tag.key) : [], [
        'suc:expires_at',
        'suc:managed_by',
        'suc:project',
        'suc:run_id',
        'suc:study_id',
      ]);
    }
  });

  it('accepts one conventional or durable variant tag on a variant validation stack only', () => {
    for (const value of ['conventional', 'durable']) {
      const tags = [...declaredTags(), { key: 'suc:variant_id', value }];
      assert.equal(checkDeclaredTags(VALIDATION_IDENTITY, tags).ok, true, value);
      assert.deepEqual(codes(checkDeclaredTags(RUN_IDENTITY, tags)), ['OWNERSHIP_TAG_INVALID']);
      assert.deepEqual(codes(checkDeclaredTags(PROBE_IDENTITY, tags)), ['OWNERSHIP_TAG_INVALID']);
    }
    const twice = [
      ...declaredTags(),
      { key: 'suc:variant_id', value: 'durable' },
      { key: 'suc:variant_id', value: 'durable' },
    ];
    assert.deepEqual(codes(checkDeclaredTags(VALIDATION_IDENTITY, twice)), ['OWNERSHIP_TAG_INVALID']);
    const unknown = [...declaredTags(), { key: 'suc:variant_id', value: 'hybrid' }];
    const result = checkDeclaredTags(VALIDATION_IDENTITY, unknown);
    assert.match(
      result.ok ? '' : (result.error[0]?.detail ?? ''),
      /^suc:variant_id \["hybrid"\] on a VARIANT_VALIDATION stack;/,
    );
  });

  it('refuses a missing or repeated base key, naming its count', () => {
    const missing = declaredTags().filter((tag) => tag.key !== 'suc:expires_at');
    const result = checkDeclaredTags(RUN_IDENTITY, missing);
    assert.deepEqual(codes(result), ['OWNERSHIP_TAG_INVALID']);
    assert.equal(result.ok ? '' : result.error[0]?.detail, 'suc:expires_at appears 0 times; expected it exactly once');
    const repeated = [...declaredTags(), { key: 'suc:project', value: 'serverless-under-constraints' }];
    assert.deepEqual(codes(checkDeclaredTags(RUN_IDENTITY, repeated)), ['OWNERSHIP_TAG_INVALID']);
  });

  it('refuses an unknown key, an empty value and a value with @', () => {
    const cases: readonly KeyValueEntry[] = [
      { key: 'owner', value: 'me' },
      { key: 'suc:other', value: 'x' },
    ];
    for (const extra of cases) {
      assert.deepEqual(codes(checkDeclaredTags(RUN_IDENTITY, [...declaredTags(), extra])), ['OWNERSHIP_TAG_INVALID']);
    }
    const empty = declaredTags().map((tag) => (tag.key === 'suc:study_id' ? { ...tag, value: '' } : tag));
    const at = declaredTags().map((tag) => (tag.key === 'suc:managed_by' ? { ...tag, value: 'ops@example' } : tag));
    assert.deepEqual(codes(checkDeclaredTags(RUN_IDENTITY, empty)), ['OWNERSHIP_TAG_INVALID']);
    const atResult = checkDeclaredTags(RUN_IDENTITY, at);
    assert.match(
      atResult.ok ? '' : (atResult.error[0]?.detail ?? ''),
      /^tag "suc:managed_by"="ops@example"; expected a suc:\* ownership key/,
    );
  });

  it('refuses a run id other than the execution id (D-07)', () => {
    const other = declaredTags().map((tag) =>
      tag.key === 'suc:run_id' ? { ...tag, value: '00000000-0000-4000-8000-000000000000' } : tag,
    );
    const result = checkDeclaredTags(RUN_IDENTITY, other);
    assert.deepEqual(codes(result), ['OWNERSHIP_TAG_INVALID']);
    assert.equal(
      result.ok ? '' : result.error[0]?.detail,
      `suc:run_id "00000000-0000-4000-8000-000000000000"; expected the execution id ${EXECUTION_ID}`,
    );
    assert.equal(result.ok ? '' : result.error[0]?.subject, 'BR-RUA-050');
  });
});

describe('observedTagReasons', () => {
  it('accepts exactly the declared suc:* tags, whatever other tags the stack has', () => {
    const declared = checkDeclaredTags(RUN_IDENTITY, declaredTags());
    assert.ok(declared.ok);
    assert.deepEqual(
      observedTagReasons(declared.value, [
        ...declaredTags().reverse(),
        { key: 'aws:cloudformation:stack-name', value: 'x' },
      ]),
      [],
    );
  });

  it('names the missing and the extra suc:* tags', () => {
    const declared = checkDeclaredTags(RUN_IDENTITY, declaredTags());
    assert.ok(declared.ok);
    const observed = [
      ...declaredTags().filter((tag) => tag.key !== 'suc:expires_at'),
      { key: 'suc:variant_id', value: 'durable' },
    ];
    const reasons = observedTagReasons(declared.value, observed);
    assert.deepEqual(
      reasons.map((reason) => [reason.code, reason.subject]),
      [['OWNERSHIP_TAG_MISMATCH', 'BR-RUA-050']],
    );
    assert.equal(
      reasons[0]?.detail,
      'the stack lacks ["suc:expires_at=2026-10-05T12:10:00.000Z"] and adds ["suc:variant_id=durable"]; expected exactly the declared suc:* tags',
    );
    const changed = declaredTags().map((tag) => (tag.key === 'suc:study_id' ? { ...tag, value: 'study-2' } : tag));
    assert.equal(observedTagReasons(declared.value, changed).length, 1);
    assert.equal(observedTagReasons(declared.value, [...declaredTags(), { key: 'suc:extra', value: 'x' }]).length, 1);
  });
});
