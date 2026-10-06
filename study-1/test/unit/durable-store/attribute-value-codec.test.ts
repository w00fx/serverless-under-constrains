// JSON ↔ AttributeValue codec: the six JSON members, safe numbers, and total decoding.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  decodeAttributeValue,
  decodeStoredItem,
  encodeAttributeMap,
  encodeAttributeValue,
  unencodableNumberReason,
} from '../../../src/durable-store/attribute-value-codec.ts';

describe('unencodableNumberReason', () => {
  it('accepts finite numbers and safe integers at the boundary', () => {
    assert.equal(unencodableNumberReason(0), undefined);
    assert.equal(unencodableNumberReason(-12.5), undefined);
    assert.equal(unencodableNumberReason(Number.MAX_SAFE_INTEGER), undefined);
    assert.equal(unencodableNumberReason(Number.MIN_SAFE_INTEGER), undefined);
    // DynamoDB's smallest magnitude is 1E-130 (HowItWorks.NamingRulesDataTypes.html).
    assert.equal(unencodableNumberReason(1e-130), undefined);
    assert.equal(unencodableNumberReason(-1e-130), undefined);
    assert.equal(unencodableNumberReason(-0), undefined);
  });

  it('names a nonzero number below the smallest DynamoDB magnitude', () => {
    assert.equal(unencodableNumberReason(1.5e-300), '1.5e-300 is nonzero with a magnitude below 1E-130');
    assert.equal(unencodableNumberReason(-9.99e-131), '-9.99e-131 is nonzero with a magnitude below 1E-130');
    assert.equal(unencodableNumberReason(5e-324), '5e-324 is nonzero with a magnitude below 1E-130');
  });

  it('names non-finite numbers and unsafe integers', () => {
    assert.equal(unencodableNumberReason(Number.NaN), 'NaN is not a finite number');
    assert.equal(unencodableNumberReason(Number.POSITIVE_INFINITY), 'Infinity is not a finite number');
    assert.equal(unencodableNumberReason(Number.NEGATIVE_INFINITY), '-Infinity is not a finite number');
    assert.equal(
      unencodableNumberReason(Number.MAX_SAFE_INTEGER + 1),
      '9007199254740992 is an integer outside the safe-integer range',
    );
    assert.equal(unencodableNumberReason(-(2 ** 53)), '-9007199254740992 is an integer outside the safe-integer range');
    // Every double of magnitude 2^53 or more is integral, so large magnitudes are refused too.
    assert.equal(unencodableNumberReason(1e300), '1e+300 is an integer outside the safe-integer range');
  });
});

describe('encodeAttributeValue', () => {
  it('maps each JSON type to its DynamoDB member', () => {
    assert.deepEqual(encodeAttributeValue(null), { NULL: true });
    assert.deepEqual(encodeAttributeValue(true), { BOOL: true });
    assert.deepEqual(encodeAttributeValue(false), { BOOL: false });
    assert.deepEqual(encodeAttributeValue(''), { S: '' });
    assert.deepEqual(encodeAttributeValue('ARMED'), { S: 'ARMED' });
    assert.deepEqual(encodeAttributeValue(10000), { N: '10000' });
    assert.deepEqual(encodeAttributeValue(-0.5), { N: '-0.5' });
    assert.deepEqual(encodeAttributeValue([]), { L: [] });
    assert.deepEqual(encodeAttributeValue({}), { M: {} });
    assert.deepEqual(encodeAttributeValue({ ids: ['a', 1], nested: { ok: null } }), {
      M: { ids: { L: [{ S: 'a' }, { N: '1' }] }, nested: { M: { ok: { NULL: true } } } },
    });
  });

  it('refuses a number that cannot round-trip, naming its path', () => {
    assert.throws(() => encodeAttributeValue({ a: [1, Number.NaN] }), {
      name: 'RangeError',
      message:
        'number at $.a[1]: NaN is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
    });
    assert.throws(() => encodeAttributeValue(2 ** 60, '$.amount'), {
      message:
        'number at $.amount: 1152921504606847000 is an integer outside the safe-integer range; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
    });
  });

  it('keeps an attribute named __proto__ as an own attribute', () => {
    const attributes = JSON.parse('{"__proto__":"x","b":1}') as Record<string, string | number>;
    const encoded = encodeAttributeMap(attributes);
    assert.deepEqual(Object.keys(encoded), ['__proto__', 'b']);
    assert.deepEqual(Object.getOwnPropertyDescriptor(encoded, '__proto__')?.value, { S: 'x' });
    assert.equal(Object.getPrototypeOf(encoded), Object.prototype);
  });
});

describe('decodeAttributeValue', () => {
  it('decodes each supported member', () => {
    assert.deepEqual(decodeAttributeValue({ S: 'x' }), { ok: true, value: 'x' });
    assert.deepEqual(decodeAttributeValue({ N: '-12.5e2' }), { ok: true, value: -1250 });
    assert.deepEqual(decodeAttributeValue({ N: '9007199254740991' }), { ok: true, value: 9007199254740991 });
    assert.deepEqual(decodeAttributeValue({ BOOL: false }), { ok: true, value: false });
    assert.deepEqual(decodeAttributeValue({ NULL: true }), { ok: true, value: null });
    assert.deepEqual(decodeAttributeValue({ L: [{ S: 'a' }, { L: [] }] }), { ok: true, value: ['a', []] });
    assert.deepEqual(decodeAttributeValue({ M: { a: { M: {} } } }), { ok: true, value: { a: {} } });
  });

  it('rejects shapes that are not one JSON member, naming the value and the expected shape', () => {
    const cases: readonly [unknown, string][] = [
      [undefined, '$ is absent; expected an AttributeValue object'],
      [null, '$ is null; expected an AttributeValue object'],
      ['S', '$ is "S"; expected an AttributeValue object'],
      [7, '$ is 7; expected an AttributeValue object'],
      [[{ S: 'a' }], '$ is an array of length 1; expected an AttributeValue object'],
      [{}, '$ has members []; expected exactly one of S, N, BOOL, NULL, L or M'],
      [{ S: 'a', N: '1' }, '$ has members ["S","N"]; expected exactly one of S, N, BOOL, NULL, L or M'],
      [{ SS: ['a'] }, '$ has member "SS"; expected exactly one of S, N, BOOL, NULL, L or M'],
      [{ B: new Uint8Array([1]) }, '$ has member "B"; expected exactly one of S, N, BOOL, NULL, L or M'],
      [{ S: 1 }, '$.S is 1; expected a string'],
      [{ N: 1 }, '$.N is 1; expected a decimal number string'],
      [{ N: '' }, '$.N is ""; expected a decimal number string'],
      [{ N: ' 1' }, '$.N is " 1"; expected a decimal number string'],
      [{ N: '0x10' }, '$.N is "0x10"; expected a decimal number string'],
      [{ N: 'Infinity' }, '$.N is "Infinity"; expected a decimal number string'],
      [
        { N: '1e400' },
        '$.N is "1e400"; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
      ],
      [
        { N: '9007199254740993' },
        '$.N is "9007199254740993"; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
      ],
      [{ BOOL: 'true' }, '$.BOOL is "true"; expected a boolean'],
      [{ NULL: false }, '$.NULL is false; expected true'],
      [{ L: {} }, '$.L is an object with members []; expected an array of AttributeValues'],
      [{ L: [{ S: 'a' }, { X: 1 }] }, '$[1] has member "X"; expected exactly one of S, N, BOOL, NULL, L or M'],
      [{ M: [] }, '$.M is an array of length 0; expected an object of AttributeValues'],
      [{ M: null }, '$.M is null; expected an object of AttributeValues'],
      [{ M: { a: { S: 'x' }, b: { N: 'x' } } }, '$.b.N is "x"; expected a decimal number string'],
      [{ S: 10n }, '$.S is a bigint; expected a string'],
      [
        { N: '1e-131' },
        '$.N is "1e-131"; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
      ],
    ];
    for (const [input, error] of cases) {
      assert.deepEqual(decodeAttributeValue(input), { ok: false, error }, JSON.stringify(String(input)));
    }
  });

  it('accepts a fraction and refuses a fraction that rounds to an unsafe integer', () => {
    assert.deepEqual(decodeAttributeValue({ N: '123456789.125' }), { ok: true, value: 123456789.125 });
    assert.deepEqual(decodeAttributeValue({ N: '12345678901234567890.5' }), {
      ok: false,
      error:
        '$.N is "12345678901234567890.5"; expected a finite number, safe when integral, zero or of magnitude at least 1E-130',
    });
  });
});

// JSON text nesting `depth` lists or maps around {"S":"x"}, parsed like an untrusted event:
// JSON.parse follows nesting far deeper than a recursive decoder could.
function nestedAttributeValue(member: 'L' | 'M', depth: number): unknown {
  const [open, close] = member === 'L' ? ['{"L":[', ']}'] : ['{"M":{"a":', '}}'];
  return JSON.parse(`${open.repeat(depth)}{"S":"x"}${close.repeat(depth)}`);
}

describe('decodeAttributeValue nesting limit (WP-04 review round 1)', () => {
  it('accepts 32 levels of lists or maps and refuses the 33rd, naming its path', () => {
    const atLimit = decodeAttributeValue(nestedAttributeValue('L', 32));
    assert.ok(atLimit.ok);
    assert.equal(JSON.stringify(atLimit.value), `${'['.repeat(32)}"x"${']'.repeat(32)}`);
    assert.deepEqual(decodeAttributeValue(nestedAttributeValue('L', 33)), {
      ok: false,
      error: `$${'[0]'.repeat(32)} nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)`,
    });
    assert.equal(decodeAttributeValue(nestedAttributeValue('M', 32)).ok, true);
    assert.deepEqual(decodeAttributeValue(nestedAttributeValue('M', 33)), {
      ok: false,
      error: `$${'.a'.repeat(32)} nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)`,
    });
  });

  it('returns an error instead of overflowing the call stack on 100,000 levels (A-05)', () => {
    const limit = 'nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)';
    assert.deepEqual(decodeAttributeValue(nestedAttributeValue('L', 100_000)), {
      ok: false,
      error: `$${'[0]'.repeat(32)} ${limit}`,
    });
    assert.deepEqual(decodeAttributeValue(nestedAttributeValue('M', 100_000)), {
      ok: false,
      error: `$${'.a'.repeat(32)} ${limit}`,
    });
  });

  it('does not count the item map as a level', () => {
    const item = { pk: { S: 'p' }, sk: { S: 's' }, deep: nestedAttributeValue('M', 32) };
    assert.equal(decodeStoredItem(item).ok, true);
    const tooDeep = { pk: { S: 'p' }, sk: { S: 's' }, deep: nestedAttributeValue('L', 100_000) };
    assert.deepEqual(decodeStoredItem(tooDeep), {
      ok: false,
      error: `$.deep${'[0]'.repeat(32)} nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)`,
    });
  });
});

describe('decoding input that is not plain data (WP-04 review round 1)', () => {
  it('refuses accessors and proxy traps that throw instead of throwing itself', () => {
    const throwingMember = {
      get S(): string {
        throw new Error('boom');
      },
    };
    assert.deepEqual(decodeAttributeValue(throwingMember), {
      ok: false,
      error: '$ could not be read (Error: boom); expected plain AttributeValue data',
    });
    const trap = new Proxy(
      {},
      {
        ownKeys: (): never => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case under test
          throw 'trap';
        },
      },
    );
    assert.deepEqual(decodeStoredItem(trap), {
      ok: false,
      error: '$ could not be read (a non-Error value); expected plain AttributeValue data',
    });
  });
});

describe('decodeStoredItem', () => {
  it('decodes an item with string keys', () => {
    assert.deepEqual(decodeStoredItem({ pk: { S: 'p' }, sk: { S: 's' }, version: { N: '3' } }), {
      ok: true,
      value: { pk: 'p', sk: 's', version: 3 },
    });
  });

  it('rejects an item without string pk and sk', () => {
    assert.deepEqual(decodeStoredItem({ pk: { N: '1' }, sk: { S: 's' } }), {
      ok: false,
      error: 'item key is pk=1, sk="s"; expected string pk and sk attributes',
    });
    assert.deepEqual(decodeStoredItem({ pk: { S: 'p' } }), {
      ok: false,
      error: 'item key is pk="p", sk=absent; expected string pk and sk attributes',
    });
    assert.deepEqual(decodeStoredItem('item'), {
      ok: false,
      error: '$.M is "item"; expected an object of AttributeValues',
    });
    assert.deepEqual(decodeStoredItem({ pk: { S: 'p' }, sk: { S: 's' }, x: { SS: [] } }), {
      ok: false,
      error: '$.x has member "SS"; expected exactly one of S, N, BOOL, NULL, L or M',
    });
  });

  it('keeps inherited member names as own attributes and refuses them as AttributeValue members (A-05)', () => {
    const decoded = decodeStoredItem(
      JSON.parse('{"pk":{"S":"p"},"sk":{"S":"s"},"constructor":{"N":"1"},"toString":{"M":{"valueOf":{"S":"v"}}}}'),
    );
    assert.ok(decoded.ok);
    assert.deepEqual(Object.keys(decoded.value), ['pk', 'sk', 'constructor', 'toString']);
    assert.deepEqual(decoded.value, JSON.parse('{"pk":"p","sk":"s","constructor":1,"toString":{"valueOf":"v"}}'));
    assert.deepEqual(decodeStoredItem(JSON.parse('{"pk":{"S":"p"},"sk":{"S":"s"},"x":{"constructor":"S"}}')), {
      ok: false,
      error: '$.x has member "constructor"; expected exactly one of S, N, BOOL, NULL, L or M',
    });
    assert.deepEqual(decodeStoredItem(JSON.parse('{"toString":{"S":"p"},"hasOwnProperty":{"S":"s"}}')), {
      ok: false,
      error: 'item key is pk=absent, sk=absent; expected string pk and sk attributes',
    });
  });

  it('keeps every refusal short however large the offending value is (WP-04 review round 2)', () => {
    const megabyte = 'x'.repeat(1024 * 1024);
    assert.deepEqual(decodeAttributeValue({ N: megabyte }), {
      ok: false,
      error: `$.N is "${'x'.repeat(199)}…[truncated]; expected a decimal number string`,
    });
    assert.deepEqual(decodeAttributeValue({ [megabyte]: 1 }), {
      ok: false,
      error: `$ has member "${'x'.repeat(199)}…[truncated]; expected exactly one of S, N, BOOL, NULL, L or M`,
    });
    const wide = Object.fromEntries(Array.from({ length: 50_000 }, (_, index) => [`m${String(index)}`, 0]));
    const wideRefusal = decodeAttributeValue(wide);
    assert.ok(!wideRefusal.ok && wideRefusal.error.length < 400, String(!wideRefusal.ok && wideRefusal.error.length));
    const wideList = decodeAttributeValue({ L: wide });
    assert.ok(!wideList.ok && wideList.error.length < 400, String(!wideList.ok && wideList.error.length));
    assert.deepEqual(decodeStoredItem({ pk: { S: 'p' }, sk: { S: megabyte, N: '1' } }), {
      ok: false,
      error: '$.sk has members ["S","N"]; expected exactly one of S, N, BOOL, NULL, L or M',
    });
  });

  it('names a long attribute in a path by a bounded quotation, decoding and encoding (A-05)', () => {
    const long = 'n'.repeat(1_000_000);
    const quoted = `"${'n'.repeat(199)}…[truncated]`;
    assert.deepEqual(decodeStoredItem({ pk: { S: 'p' }, sk: { S: 's' }, m: { M: { [long]: { N: 'x' } } } }), {
      ok: false,
      error: `$.m.${quoted}.N is "x"; expected a decimal number string`,
    });
    assert.throws(
      () => encodeAttributeMap({ pk: 'p', sk: 's', [long]: Number.NaN }),
      new RangeError(
        `number at $.${quoted}: NaN is not a finite number; expected a finite number, safe when integral, zero or of magnitude at least 1E-130`,
      ),
    );
  });

  it('keeps an attribute named __proto__ as an own attribute', () => {
    const decoded = decodeStoredItem(JSON.parse('{"pk":{"S":"p"},"sk":{"S":"s"},"__proto__":{"S":"x"}}'));
    assert.ok(decoded.ok);
    assert.deepEqual(Object.keys(decoded.value), ['pk', 'sk', '__proto__']);
    assert.equal(Object.getPrototypeOf(decoded.value), Object.prototype);
  });
});
