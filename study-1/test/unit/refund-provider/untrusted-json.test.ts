// The provider's total, bounded handling of runtime-parsed values (WP-07 review round 1), now
// built on the kernel helpers (Owner amendment A-05, policy 1): the describers are the kernel's
// `describeJson` and `boundedJsonText`, made well formed and naming a top-level non-finite number;
// the request digest equals the canonical-JSON digest for every finite payload while staying total
// over Infinity and nesting of any depth.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  describeUntrusted,
  describeWriteOutcome,
  excerptUntrusted,
  requestDigest,
} from '../../../src/refund-provider/untrusted-json.ts';

const UTF8 = new TextEncoder();
const DEEP = 100_000;
/** The marker the kernel's `boundedJsonText` appends to a cut text. */
const TRUNCATED = '…[truncated]';

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

  it('names a non-finite number instead of printing null, and keeps JSON text for nested ones', () => {
    assert.equal(describeUntrusted(Number.POSITIVE_INFINITY), 'number Infinity');
    assert.equal(describeUntrusted(Number.NEGATIVE_INFINITY), 'number -Infinity');
    assert.equal(describeUntrusted(Number.NaN), 'number NaN');
    // Nested values are the kernel's bounded JSON text, which names a non-finite number too (A-05).
    assert.equal(describeUntrusted([Number.POSITIVE_INFINITY, 1]), 'array [Infinity,1]');
  });

  it('echoes exactly the kernel bound and cuts what goes one code unit beyond it', () => {
    const atBound = 'x'.repeat(QUOTED_JSON_LIMIT - 2);
    assert.equal(excerptUntrusted(atBound), `"${atBound}"`);
    const overBound = 'x'.repeat(QUOTED_JSON_LIMIT - 1);
    assert.equal(excerptUntrusted(overBound), `"${'x'.repeat(QUOTED_JSON_LIMIT - 1)}${TRUNCATED}`);
    assert.equal(excerptUntrusted('y'.repeat(1_000_000)), `"${'y'.repeat(QUOTED_JSON_LIMIT - 1)}${TRUNCATED}`);
    assert.equal(excerptUntrusted({ ['k'.repeat(500)]: 1 }), `{"${'k'.repeat(QUOTED_JSON_LIMIT - 2)}${TRUNCATED}`);
  });

  it('keeps a detail well formed when the cut splits a surrogate pair', () => {
    // 200 code units of the quoted text end in the high half of the 100th pair.
    const emoji = '\u{1F600}';
    const cutInsidePair = excerptUntrusted(emoji.repeat(200));
    assert.equal(cutInsidePair, `"${emoji.repeat(99)}\u{FFFD}${TRUNCATED}`);
    assert.equal(cutInsidePair.isWellFormed(), true);
    assert.equal(describeUntrusted(emoji.repeat(200)).isWellFormed(), true);
    const cutBetweenPairs = excerptUntrusted(`a${emoji.repeat(200)}`);
    assert.equal(cutBetweenPairs, `"a${emoji.repeat(99)}${TRUNCATED}`);
  });

  it('describes nesting of any depth without throwing, within the bound', () => {
    const deep = JSON.parse(`${'['.repeat(DEEP)}${']'.repeat(DEEP)}`) as JsonValue;
    assert.equal(describeUntrusted(deep), `array ${'['.repeat(QUOTED_JSON_LIMIT)}${TRUNCATED}`);
    const wide = Array.from({ length: 10_000 }, (_, index) => index);
    assert.equal(excerptUntrusted(wide), `${JSON.stringify(wide).slice(0, QUOTED_JSON_LIMIT)}${TRUNCATED}`);
  });
});

describe('describeWriteOutcome', () => {
  it('renders a small outcome as its JSON text', () => {
    assert.equal(
      describeWriteOutcome({ kind: 'ambiguous', code: 'TimeoutError' }),
      '{"kind":"ambiguous","code":"TimeoutError"}',
    );
  });

  it('bounds the item a failed condition returned, however large', () => {
    const existing = { pk: 'p', sk: 's', refund_request_id: 'r'.repeat(300_000) };
    const described = describeWriteOutcome({ kind: 'condition_failed', failed_action_index: 0, existing });
    assert.ok(described.startsWith('{"kind":"condition_failed","failed_action_index":0,"existing":{"pk":"p"'));
    assert.equal(described.length, QUOTED_JSON_LIMIT + TRUNCATED.length);
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

  it('digests an own member named like an Object.prototype member as an ordinary key', () => {
    const text = '{"__proto__":{"a":1},"constructor":2,"toString":3}';
    assert.equal(requestDigest(JSON.parse(text) as JsonValue), digestOfText(text));
  });
});
