// BR-RUA-033 canonical serialization and BR-RUA-034 structural equivalence.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canonicalJson,
  serializeJsonl,
  serializeRecordFile,
  structurallyEqual,
} from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';

const decoder = new TextDecoder();

describe('canonicalJson', () => {
  it('sorts object keys by UTF-16 code units at every depth and writes no whitespace', () => {
    const value = { b: 1, a: { d: [3, { z: true, y: null }], c: 'x' }, B: 2, é: 0, '\u{1F600}': 1, '￿': 2 };
    assert.equal(
      canonicalJson(value),
      '{"B":2,"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1,"é":0,"\u{1F600}":1,"￿":2}',
    );
  });

  it('orders integer-like keys by code units, not by JavaScript enumeration order', () => {
    // Promoted from the canonical-json fuzz target (seed -1582680199): `{"0":null,"":[]}`.
    assert.equal(canonicalJson({ '0': null, '': [] }), '{"":[],"0":null}');
    assert.equal(canonicalJson({ '9': 2, '10': 1, a: 0 }), '{"10":1,"9":2,"a":0}');
  });

  it('keeps array order and writes scalars in JSON form', () => {
    assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
    assert.equal(canonicalJson('quote " and \\ and \n'), '"quote \\" and \\\\ and \\n"');
    assert.equal(canonicalJson(null), 'null');
    assert.equal(canonicalJson(false), 'false');
    assert.equal(canonicalJson(1e21), '1e+21');
    assert.equal(canonicalJson(-0), '0');
    assert.equal(canonicalJson(0.1), '0.1');
    assert.equal(canonicalJson([]), '[]');
    assert.equal(canonicalJson({}), '{}');
  });

  it('accepts null-prototype objects', () => {
    const value = Object.assign(Object.create(null) as Record<string, JsonValue>, { b: 1, a: 2 });
    assert.equal(canonicalJson(value), '{"a":2,"b":1}');
  });

  it('rejects values JSON cannot represent, naming the path and the expected shape', () => {
    const cases: readonly [unknown, RegExp][] = [
      [Number.NaN, /number at \$ is NaN; expected a finite JSON number/],
      [{ a: [1, Number.POSITIVE_INFINITY] }, /number at \$\.a\[1\] is Infinity/],
      [
        { a: undefined },
        /value at \$\.a is of type undefined; expected null, boolean, number, string, array or plain object/,
      ],
      [{ when: new Date(0) }, /value at \$\.when is an instance of Date/],
      [[1n], /value at \$\[0\] is of type bigint/],
      [(): number => 1, /value at \$ is of type function/],
      [new Map(), /is an instance of Map/],
    ];
    for (const [value, pattern] of cases) {
      assert.throws(
        () => canonicalJson(value as JsonValue),
        (error: unknown) => error instanceof TypeError && pattern.test(error.message),
      );
    }
  });

  it('names a class instance by its constructor and a constructor-less object by its tag', () => {
    class Amount {
      readonly minor = 1;
    }
    const orphan: unknown = Object.create(Object.create(null) as object);
    assert.throws(
      () => canonicalJson({ amount: new Amount() } as unknown as JsonValue),
      /value at \$\.amount is an instance of Amount;/,
    );
    assert.throws(() => canonicalJson([orphan] as JsonValue), /value at \$\[0\] is an instance of \[object Object\];/);
  });

  it('rejects array holes instead of writing invalid JSON', () => {
    const sparse: JsonValue[] = [];
    sparse[1] = 1;
    assert.throws(() => canonicalJson(sparse), /value at \$\[0\] is of type undefined/);
  });
});

describe('structurallyEqual', () => {
  it('ignores object property order', () => {
    assert.equal(structurallyEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true);
  });

  it('treats array order and JSON types as significant', () => {
    assert.equal(structurallyEqual([1, 2], [2, 1]), false);
    assert.equal(structurallyEqual(1, '1'), false);
    assert.equal(structurallyEqual(null, false), false);
    assert.equal(structurallyEqual({ a: 1 }, { a: 1, b: null }), false);
  });

  it('compares numbers by value', () => {
    assert.equal(structurallyEqual(JSON.parse('1.0') as JsonValue, 1), true);
    assert.equal(structurallyEqual(-0, 0), true);
  });
});

describe('record serialization', () => {
  const record = {
    schema_version: 1,
    record_type: 'payment',
    payment_id: 'pay-poc-001',
    captured_amount_minor: 10000,
    currency: 'BRL',
  } as const satisfies StudyRecord & Record<string, JsonValue>;

  it('writes one canonical record followed by exactly one newline in UTF-8', () => {
    const bytes = serializeRecordFile(record);
    assert.equal(
      decoder.decode(bytes),
      '{"captured_amount_minor":10000,"currency":"BRL","payment_id":"pay-poc-001","record_type":"payment","schema_version":1}\n',
    );
    const accentedRecord = { ...record, payment_id: 'é' };
    const accented = serializeRecordFile(accentedRecord);
    assert.equal(Buffer.from(accented).indexOf(Buffer.of(0xc3, 0xa9)), decoder.decode(accented).indexOf('é'));
    assert.equal(accented.length, new TextEncoder().encode(decoder.decode(accented)).length);
  });

  it('writes JSONL as one newline-terminated canonical line per record', () => {
    const second = { ...record, payment_id: 'pay-poc-002' };
    assert.equal(
      decoder.decode(serializeJsonl([record, second])),
      `${canonicalJson(record)}\n${canonicalJson(second)}\n`,
    );
    assert.equal(serializeJsonl([]).length, 0);
  });

  it('refuses a record holding an undefined optional property', () => {
    const withUndefined = { ...record, note: undefined } as unknown as StudyRecord;
    assert.throws(() => serializeRecordFile(withUndefined), /value at \$\.note is of type undefined/);
    assert.throws(() => serializeJsonl([withUndefined]), /value at \$\.note is of type undefined/);
  });
});
