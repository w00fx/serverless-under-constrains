// The provider's total, bounded handling of runtime-parsed values (WP-07 review round 1): the
// describer echoes a bounded excerpt in member order and names non-finite numbers, and the
// request digest equals the canonical-JSON digest for every finite payload while staying total
// over Infinity and nesting of any depth.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  DESCRIBED_VALUE_MAX_CHARS,
  describeUntrusted,
  excerptUntrusted,
  requestDigest,
  TRUNCATION_MARKER,
} from '../../../src/refund-provider/untrusted-json.ts';

const UTF8 = new TextEncoder();
const DEEP = 100_000;

function digestOfText(text: string): string {
  return sha256Hex(UTF8.encode(text));
}

describe('describeUntrusted', () => {
  it('names the JSON type and serializes small values exactly as JSON.stringify does', () => {
    assert.equal(describeUntrusted(undefined), 'absent');
    assert.equal(describeUntrusted(null), 'null null');
    assert.equal(describeUntrusted(true), 'boolean true');
    assert.equal(describeUntrusted(-0), 'number 0');
    assert.equal(describeUntrusted(1.5), 'number 1.5');
    assert.equal(describeUntrusted('a"b\n'), 'string "a\\"b\\n"');
    assert.equal(describeUntrusted([]), 'array []');
    assert.equal(describeUntrusted({}), 'object {}');
    const nested = { b: [1, { z: null, a: 'x' }], a: [[], {}] } as const;
    assert.equal(describeUntrusted(nested), `object ${JSON.stringify(nested)}`);
    assert.equal(describeUntrusted(nested), 'object {"b":[1,{"z":null,"a":"x"}],"a":[[],{}]}');
  });

  it('names non-finite numbers instead of printing null', () => {
    assert.equal(describeUntrusted(Number.POSITIVE_INFINITY), 'number Infinity');
    assert.equal(describeUntrusted(Number.NEGATIVE_INFINITY), 'number -Infinity');
    assert.equal(describeUntrusted(Number.NaN), 'number NaN');
    assert.equal(describeUntrusted([Number.POSITIVE_INFINITY, 1]), 'array [Infinity,1]');
  });

  it('echoes exactly the bound and cuts what goes one code unit beyond it', () => {
    const atBound = 'x'.repeat(DESCRIBED_VALUE_MAX_CHARS - 2);
    assert.equal(excerptUntrusted(atBound), `"${atBound}"`);
    const overBound = 'x'.repeat(DESCRIBED_VALUE_MAX_CHARS - 1);
    assert.equal(excerptUntrusted(overBound), `"${'x'.repeat(DESCRIBED_VALUE_MAX_CHARS - 1)}${TRUNCATION_MARKER}`);
    assert.equal(DESCRIBED_VALUE_MAX_CHARS, 120);
    assert.equal(TRUNCATION_MARKER, '… (truncated)');
  });

  it('slices long strings and keys before quoting, and never splits a surrogate pair', () => {
    assert.equal(excerptUntrusted('y'.repeat(1_000_000)), `"${'y'.repeat(119)}${TRUNCATION_MARKER}`);
    assert.equal(excerptUntrusted({ ['k'.repeat(500)]: 1 }), `{"${'k'.repeat(118)}${TRUNCATION_MARKER}`);
    // 120 code units of the quoted text end in the high half of the 60th pair, which is dropped.
    const emoji = '\u{1F600}';
    const cutInsidePair = excerptUntrusted(emoji.repeat(200));
    assert.equal(cutInsidePair, `"${emoji.repeat(59)}${TRUNCATION_MARKER}`);
    assert.equal(cutInsidePair.isWellFormed(), true);
    const cutBetweenPairs = excerptUntrusted(`a${emoji.repeat(200)}`);
    assert.equal(cutBetweenPairs, `"a${emoji.repeat(59)}${TRUNCATION_MARKER}`);
  });

  it('describes nesting of any depth without throwing, within the bound', () => {
    const deep = JSON.parse(`${'['.repeat(DEEP)}${']'.repeat(DEEP)}`) as JsonValue;
    assert.equal(describeUntrusted(deep), `array ${'['.repeat(120)}${TRUNCATION_MARKER}`);
    const wide = Array.from({ length: 10_000 }, (_, index) => index);
    assert.equal(excerptUntrusted(wide), `${JSON.stringify(wide).slice(0, 120)}${TRUNCATION_MARKER}`);
  });
});

describe('requestDigest', () => {
  it('equals the canonical-JSON digest of a finite payload, whatever its member order', () => {
    const payload = { b: [2, 1, { y: '\u0000', x: -0 }], a: 'é', c: {}, d: [] };
    assert.equal(requestDigest(payload), sha256Hex(UTF8.encode(canonicalJson(payload))));
    assert.equal(requestDigest(payload), digestOfText('{"a":"é","b":[2,1,{"x":0,"y":"\\u0000"}],"c":{},"d":[]}'));
    assert.equal(requestDigest({ c: {}, d: [], a: 'é', b: [2, 1, { x: -0, y: '\u0000' }] }), requestDigest(payload));
    assert.equal(requestDigest('x'.repeat(5000)), digestOfText(JSON.stringify('x'.repeat(5000))));
  });

  it('writes non-finite numbers as bare tokens no finite payload can share', () => {
    assert.equal(requestDigest({ a: Number.POSITIVE_INFINITY }), digestOfText('{"a":Infinity}'));
    assert.equal(requestDigest([Number.NEGATIVE_INFINITY]), digestOfText('[-Infinity]'));
    assert.notEqual(requestDigest({ a: Number.POSITIVE_INFINITY }), requestDigest({ a: null }));
    assert.notEqual(requestDigest({ a: Number.POSITIVE_INFINITY }), requestDigest({ a: 'Infinity' }));
  });

  it('digests nesting of any depth without throwing', () => {
    const text = `${'{"a":'.repeat(DEEP)}[]${'}'.repeat(DEEP)}`;
    assert.equal(requestDigest(JSON.parse(text) as JsonValue), digestOfText(text));
  });
});
