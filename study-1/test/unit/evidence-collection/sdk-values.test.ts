// The total readers of untrusted service output (Owner amendment A-05): own members only, no
// throw on any value, and `undefined` for anything outside the expected shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mapDlqMessage } from '../../../src/evidence-collection/dlq-capture.ts';

import {
  digitCount,
  instantOfDate,
  instantOfEpochText,
  nonEmptyString,
  ownValue,
  quoted,
  safeCount,
  settleSdkCall,
} from '../../../src/evidence-collection/sdk-values.ts';
import { parsedTower, DEEP_NESTING } from '../../support/kernel/deep-json.ts';

describe('ownValue (A-05: own members only)', () => {
  it('reads an own member and nothing inherited', () => {
    assert.equal(ownValue({ Body: 'x' }, 'Body'), 'x');
    assert.equal(ownValue({}, 'toString'), undefined);
    assert.equal(ownValue(Object.create({ Body: 'inherited' }) as object, 'Body'), undefined);
    assert.equal(ownValue(JSON.parse('{"__proto__":{"Body":"x"}}') as object, 'Body'), undefined);
  });

  it('is undefined for a non-object holder', () => {
    for (const holder of [undefined, null, 'Body', 7, true]) {
      assert.equal(ownValue(holder, 'Body'), undefined);
    }
  });
});

describe('scalar readers', () => {
  it('nonEmptyString keeps only strings with a character', () => {
    assert.equal(nonEmptyString('a'), 'a');
    assert.equal(nonEmptyString(''), undefined);
    assert.equal(nonEmptyString(1), undefined);
  });

  it('safeCount refuses non-finite, fractional, unsafe and small numbers', () => {
    assert.equal(safeCount(2, 1), 2);
    assert.equal(safeCount(1, 1), 1);
    assert.equal(safeCount(0, 1), undefined);
    for (const value of [Infinity, -Infinity, NaN, 1.5, 2 ** 53, '2']) {
      assert.equal(safeCount(value, 0), undefined, String(value));
    }
    assert.equal(safeCount(JSON.parse('1e400') as number, 0), undefined);
  });

  it('digitCount reads canonical digit strings only', () => {
    assert.equal(digitCount('0', 0), 0);
    assert.equal(digitCount('12', 1), 12);
    for (const value of ['02', '-1', '1.0', '', ' 1', '1e3', '9007199254740993', 7]) {
      assert.equal(digitCount(value, 0), undefined, String(value));
    }
    assert.equal(digitCount('0', 1), undefined);
  });
});

describe('instants (BR-RUA-033 millisecond UTC)', () => {
  it('formats a valid Date and refuses the rest', () => {
    assert.equal(instantOfDate(new Date(Date.UTC(2026, 9, 5, 12, 15, 5, 123))), '2026-10-05T12:15:05.123Z');
    assert.equal(instantOfDate(new Date(Number.NaN)), undefined);
    assert.equal(instantOfDate(new Date(8.64e15)), undefined);
    assert.equal(instantOfDate('2026-10-05T12:15:05.123Z'), undefined);
    assert.equal(instantOfDate(1791202505000), undefined);
  });

  it('keeps the bounds of years 0000 and 9999', () => {
    assert.equal(instantOfDate(new Date('0000-01-01T00:00:00.000Z')), '0000-01-01T00:00:00.000Z');
    assert.equal(instantOfDate(new Date(Date.parse('0000-01-01T00:00:00.000Z') - 1)), undefined);
    assert.equal(instantOfDate(new Date('9999-12-31T23:59:59.999Z')), '9999-12-31T23:59:59.999Z');
    assert.equal(instantOfDate(new Date(Date.parse('9999-12-31T23:59:59.999Z') + 1)), undefined);
  });

  it('reads SQS epoch-millisecond attributes losslessly', () => {
    assert.equal(instantOfEpochText(String(Date.UTC(2026, 9, 5, 12, 35, 5, 400))), '2026-10-05T12:35:05.400Z');
    assert.equal(instantOfEpochText('0'), '1970-01-01T00:00:00.000Z');
    for (const value of ['253402300800000', '-1', '1e3', 1791202505000, undefined]) {
      assert.equal(instantOfEpochText(value), undefined, String(value));
    }
  });
});

describe('quoted', () => {
  it('renders any value bounded, without throwing', () => {
    assert.equal(quoted(undefined), 'absent');
    assert.equal(quoted('x'), '"x"');
    assert.equal(quoted(new Date(5)), 'a Date of 5 ms');
    assert.equal(quoted(JSON.parse('1e400')), 'Infinity');
    assert.ok(quoted('y'.repeat(10_000)).length < 300);
    assert.ok(quoted(parsedTower('array', DEEP_NESTING)).length < 300);
  });

  // Regression of fuzz seed 2099329007 (sdk-response-mapping.fuzz.test.ts): a BigInt nested in an
  // SDK member made the bounded JSON rendering throw out of a mapper.
  it('renders a value holding a BigInt as having no JSON text', () => {
    assert.equal(quoted(0n), 'a value with no JSON text');
    assert.equal(quoted({ '': 0n }), 'a value with no JSON text');
    assert.deepEqual(mapDlqMessage({ MessageId: { '': 0n } }).ok, false);
  });
});

describe('settleSdkCall', () => {
  it('returns the output of a call that resolves', async () => {
    assert.deepEqual(await settleSdkCall(() => Promise.resolve(3)), { ok: true, value: 3 });
  });

  it('names a failure by the thrown error name, own or inherited', async () => {
    const service = Object.assign(new Error('slow'), { name: 'ThrottlingException' });
    assert.deepEqual(await settleSdkCall(() => Promise.reject(service)), {
      ok: false,
      error: { code: 'ThrottlingException' },
    });
    assert.deepEqual(await settleSdkCall(() => Promise.reject(new TypeError('x'))), {
      ok: false,
      error: { code: 'TypeError' },
    });
  });

  it('reads a non-Error rejection by its own name only', async () => {
    const rejectWith = (value: unknown): Promise<unknown> => settleSdkCall(() => Promise.reject(value as Error));
    assert.deepEqual(await rejectWith({ name: 'Custom' }), { ok: false, error: { code: 'Custom' } });
    for (const value of [undefined, 'boom', { name: '' }, Object.create({ name: 'Inherited' }) as object]) {
      assert.deepEqual(await rejectWith(value), { ok: false, error: { code: 'UnknownError' } });
    }
  });
});
