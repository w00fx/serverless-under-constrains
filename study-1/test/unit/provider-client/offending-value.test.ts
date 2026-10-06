// The bounded renderings of untrusted values (WP-06 review round 1): a structured reason repeats
// at most 256 characters of an offending value, never splits a surrogate pair, and describes a
// container by kind and size without recursing, so any nesting depth is safe.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  boundedText,
  describeJsonValue,
  OFFENDING_VALUE_PREVIEW_CHARS,
} from '../../../src/provider-client/offending-value.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

// The fixed suffix of a cut text: '... (' + up to 16 digits + ' chars)'.
const MAX_SUFFIX_CHARS = 27;

describe('boundedText', () => {
  it('keeps a text of up to 256 characters unchanged', () => {
    assert.equal(OFFENDING_VALUE_PREVIEW_CHARS, 256);
    assert.equal(boundedText(''), '');
    assert.equal(boundedText('Y'.repeat(256)), 'Y'.repeat(256));
  });

  it('cuts a longer text to 256 characters and names its length', () => {
    assert.equal(boundedText('Y'.repeat(257)), `${'Y'.repeat(256)}... (257 chars)`);
    assert.equal(boundedText(`${'a'.repeat(256)}bc`), `${'a'.repeat(256)}... (258 chars)`);
  });

  it('never splits a surrogate pair at the cut', () => {
    const pairAtCut = `${'a'.repeat(255)}\u{1F600}tail`;
    assert.equal(boundedText(pairAtCut), `${'a'.repeat(255)}... (261 chars)`);
    const pairBeforeCut = `${'a'.repeat(254)}\u{1F600}tail`;
    assert.equal(boundedText(pairBeforeCut), `${'a'.repeat(254)}\u{1F600}... (260 chars)`);
    const lowSurrogateAtCut = `${'a'.repeat(255)}\uDC00tail`;
    assert.equal(boundedText(lowSurrogateAtCut), `${'a'.repeat(255)}\uDC00... (260 chars)`);
    const highSurrogateMax = `${'a'.repeat(255)}\uDBFFtail`;
    assert.equal(boundedText(highSurrogateMax), `${'a'.repeat(255)}... (260 chars)`);
    const belowHighSurrogates = `${'a'.repeat(255)}퟿tail`;
    assert.equal(boundedText(belowHighSurrogates), `${'a'.repeat(255)}퟿... (260 chars)`);
  });

  it('is a prefix of the text plus at most the fixed suffix (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 600 }), (text) => {
        const bounded = boundedText(text);
        assert.ok(bounded.length <= OFFENDING_VALUE_PREVIEW_CHARS + MAX_SUFFIX_CHARS);
        const kept = bounded === text ? text : bounded.slice(0, bounded.lastIndexOf('... ('));
        assert.ok(text.startsWith(kept));
      }),
      fuzzParameters(),
    );
  });
});

describe('describeJsonValue', () => {
  it('renders scalars as JSON text and an absent value as undefined', () => {
    assert.equal(describeJsonValue('TOO_LATE'), '"TOO_LATE"');
    assert.equal(describeJsonValue(7), '7');
    assert.equal(describeJsonValue(false), 'false');
    assert.equal(describeJsonValue(null), 'null');
    assert.equal(describeJsonValue(undefined), 'undefined');
  });

  it('describes containers by kind and size only', () => {
    assert.equal(describeJsonValue([]), 'an array of length 0');
    assert.equal(describeJsonValue([1, [2, 3]]), 'an array of length 2');
    assert.equal(describeJsonValue({}), 'an object with 0 key(s)');
    assert.equal(describeJsonValue({ a: { b: 1 }, c: 2 }), 'an object with 2 key(s)');
  });

  it('bounds a long string scalar', () => {
    assert.equal(describeJsonValue('Z'.repeat(300)), `"${'Z'.repeat(255)}... (302 chars)`);
  });

  // Regression (WP-06 review round 1): JSON.stringify of a 10,000-deep array threw RangeError.
  it('describes a value nested 100,000 deep without recursing', () => {
    const deep = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`) as JsonValue;
    assert.equal(describeJsonValue(deep), 'an array of length 1');
  });
});
