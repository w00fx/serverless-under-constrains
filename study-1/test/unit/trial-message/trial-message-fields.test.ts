// The own-property readers every trial-message guard uses (Owner amendment A-05: inherited member
// names are never fields), the execution-identity readers, and the OR-RUA-001 refund fixture.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { OR_RUA_001_REFUND } from '../../../src/trial-message/approved-refund.ts';
import {
  executionIdentityOfTrial,
  executionRefOf,
  isNonemptyTrimmed,
  ownField,
  trialExecutionOf,
  unexpectedField,
} from '../../../src/trial-message/trial-message-fields.ts';
import { RUN_ID, VALIDATION_ID } from './support/trial-message-fixtures.ts';

function parsed(text: string): JsonObject {
  return JSON.parse(text) as JsonObject;
}

describe('ownField', () => {
  it('reads own properties, including inherited names that JSON defines as own', () => {
    assert.equal(ownField(parsed('{"__proto__":1,"constructor":2}'), '__proto__'), 1);
    assert.equal(ownField(parsed('{"__proto__":1,"constructor":2}'), 'constructor'), 2);
  });

  it('never reads an inherited member', () => {
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.equal(ownField({}, name), undefined);
    }
  });
});

describe('unexpectedField', () => {
  it('returns the first property outside the allowed set', () => {
    assert.equal(unexpectedField({ a: 1, b: 2, c: 3 }, new Set(['a'])), 'b');
    assert.equal(unexpectedField({ a: 1 }, new Set(['a', 'b'])), undefined);
    assert.equal(unexpectedField(parsed('{"__proto__":1}'), new Set(['a'])), '__proto__');
  });
});

describe('isNonemptyTrimmed', () => {
  it('matches the nonempty_trimmed schema definition', () => {
    for (const accepted of ['a', 'ref-poc-001', 'a b']) {
      assert.equal(isNonemptyTrimmed(accepted), true, accepted);
    }
    for (const refused of ['', ' ', ' a', 'a ', 'a\nb', '\t', 1, null, undefined]) {
      assert.equal(isNonemptyTrimmed(refused), false, String(refused));
    }
  });
});

describe('trialExecutionOf', () => {
  it('reads exactly one execution identity', () => {
    assert.deepEqual(trialExecutionOf({ run_id: RUN_ID }), { field: 'run_id', id: RUN_ID });
    assert.deepEqual(trialExecutionOf({ variant_validation_id: VALIDATION_ID }), {
      field: 'variant_validation_id',
      id: VALIDATION_ID,
    });
  });

  it('refuses both, neither, a malformed identity, and a present but null one', () => {
    for (const object of [
      { run_id: RUN_ID, variant_validation_id: VALIDATION_ID },
      {},
      { run_id: RUN_ID.toUpperCase() },
      { variant_validation_id: 'x' },
      { run_id: RUN_ID, variant_validation_id: null },
      { run_id: null, variant_validation_id: VALIDATION_ID },
    ]) {
      assert.equal(trialExecutionOf(object), undefined, JSON.stringify(object));
    }
  });
});

describe('executionRefOf and executionIdentityOfTrial', () => {
  it('project a typed trial-scoped record onto its execution identity', () => {
    assert.deepEqual(executionRefOf({ run_id: RUN_ID }), { field: 'run_id', id: RUN_ID });
    assert.deepEqual(executionRefOf({ variant_validation_id: VALIDATION_ID }), {
      field: 'variant_validation_id',
      id: VALIDATION_ID,
    });
    assert.deepEqual(executionIdentityOfTrial({ run_id: RUN_ID }), { run_id: RUN_ID });
    assert.deepEqual(executionIdentityOfTrial({ variant_validation_id: VALIDATION_ID }), {
      variant_validation_id: VALIDATION_ID,
    });
  });
});

describe('OR_RUA_001_REFUND', () => {
  it('is the OR-RUA-001 financial fixture', () => {
    assert.deepEqual(OR_RUA_001_REFUND, {
      payment_id: 'pay-poc-001',
      refund_request_id: 'ref-poc-001',
      amount_minor: 10000,
      currency: 'BRL',
    });
  });
});
