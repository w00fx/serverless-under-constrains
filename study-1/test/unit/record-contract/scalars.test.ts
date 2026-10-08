// BR-RUA-033 scalar rules: lowercase UUIDv4, UTC millisecond timestamps, lowercase SHA-256,
// safe-integer amounts and decimal-string aggregates.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  compareDecimal,
  elapsedNs,
  isDecimalString,
  signedDifferenceMs,
  sumMinorUnits,
} from '../../../src/record-contract/decimal.ts';
import { isSha256Hex, sha256Hex } from '../../../src/record-contract/digests.ts';
import { UUID4_PATTERN, isUuid4, parseUuid4 } from '../../../src/record-contract/identifiers.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import { NONEMPTY_TRIMMED_PATTERN } from '../../../src/record-contract/primitives.ts';
import type { DecimalString, UtcMillis } from '../../../src/record-contract/primitives.ts';
import { DEFAULT_SCHEMA_ROOT } from '../../../src/record-contract/schema-registry.ts';
import { formatUtcMillis, isUtcMillis, parseUtcMillis } from '../../../src/record-contract/timestamps.ts';

const UUID = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f';

describe('UUIDv4 identifiers', () => {
  it('accepts only canonical lowercase version-4 UUIDs', () => {
    assert.equal(isUuid4(UUID), true);
    // Fixed literals, one per RFC 4122 variant digit, keep the case repeatable (review round 1).
    for (const good of [
      '00000000-0000-4000-8000-000000000000',
      'ffffffff-ffff-4fff-9fff-ffffffffffff',
      '0123abcd-4567-4890-a1b2-c3d4e5f60789',
      'abcdef01-2345-4678-b9ab-cdef01234567',
    ]) {
      assert.equal(isUuid4(good), true, good);
    }
    for (const bad of [
      UUID.toUpperCase(),
      UUID.replace('-4c1e-', '-1c1e-'),
      UUID.replace('-9f00-', '-7f00-'),
      `${UUID}0`,
      ` ${UUID}`,
      UUID.replaceAll('-', ''),
      42,
      null,
    ]) {
      assert.equal(isUuid4(bad), false, String(bad));
    }
  });

  it('parses with a structured reason naming the offending value', () => {
    assert.deepEqual(parseUuid4(UUID), { ok: true, value: UUID });
    const parsed = parseUuid4('ABC', 'trial_id');
    assert.equal(parsed.ok, false);
    assert.deepEqual(
      { code: parsed.error.code, subject: parsed.error.subject },
      { code: 'INVALID_UUID4', subject: 'trial_id' },
    );
    assert.match(parsed.error.detail, /got "ABC"; expected a lowercase RFC 4122 version-4 UUID/);
    const defaulted = parseUuid4('x');
    assert.equal(defaulted.ok, false);
    assert.equal(defaulted.error.subject, 'uuid4');
  });

  it('quotes a multi-megabyte value bounded (WP-00 review round 2, A-05)', () => {
    const parsed = parseUuid4('u'.repeat(5_000_000));
    assert.equal(parsed.ok, false);
    assert.equal(
      parsed.error.detail,
      `got "${'u'.repeat(QUOTED_JSON_LIMIT - 1)}…[truncated]; expected a lowercase RFC 4122 version-4 UUID matching ${UUID4_PATTERN.source}`,
    );
  });
});

describe('UTC millisecond timestamps', () => {
  it('accepts exactly millisecond UTC instants that exist', () => {
    for (const good of ['2026-10-05T12:00:00.000Z', '2024-02-29T23:59:59.999Z', '0000-01-01T00:00:00.000Z']) {
      assert.equal(isUtcMillis(good), true, good);
    }
  });

  it('rejects other precisions, offsets, impossible dates and non-strings', () => {
    const bad = [
      '2026-10-05T12:00:00Z',
      '2026-10-05T12:00:00.0000Z',
      '2026-10-05T12:00:00.000+00:00',
      '2026-10-05 12:00:00.000Z',
      '2026-02-30T00:00:00.000Z',
      '2026-13-01T00:00:00.000Z',
      '2026-10-05T24:00:00.000Z',
      '2026-10-05T23:60:00.000Z',
      ' 2026-10-05T12:00:00.000Z',
      1791230400000,
      undefined,
    ];
    for (const value of bad) {
      assert.equal(isUtcMillis(value), false, String(value));
    }
  });

  it('formats instants and refuses unrepresentable ones', () => {
    assert.equal(formatUtcMillis(new Date(Date.UTC(2026, 9, 5, 1, 2, 3, 4))), '2026-10-05T01:02:03.004Z');
    assert.throws(
      () => formatUtcMillis(new Date(Number.NaN)),
      /cannot format "Invalid Date" as UTC millis; expected a valid instant/,
    );
    assert.throws(
      () => formatUtcMillis(new Date(Date.UTC(10000, 0, 1))),
      /cannot format "\+010000-01-01T00:00:00\.000Z"/,
    );
  });

  it('parses with a structured reason', () => {
    assert.deepEqual(parseUtcMillis('2026-10-05T12:00:00.000Z'), { ok: true, value: '2026-10-05T12:00:00.000Z' });
    const parsed = parseUtcMillis('2026-02-30T00:00:00.000Z', 'occurred_at');
    assert.equal(parsed.ok, false);
    assert.deepEqual([parsed.error.code, parsed.error.subject], ['INVALID_UTC_MILLIS', 'occurred_at']);
    assert.match(parsed.error.detail, /got "2026-02-30T00:00:00\.000Z"; expected an existing UTC instant/);
    const defaulted = parseUtcMillis('x');
    assert.equal(defaulted.ok, false);
    assert.equal(defaulted.error.subject, 'utc_millis');
    const huge = parseUtcMillis('t'.repeat(5_000_000));
    assert.equal(huge.ok, false);
    assert.equal(
      huge.error.detail,
      `got "${'t'.repeat(QUOTED_JSON_LIMIT - 1)}…[truncated]; expected an existing UTC instant formatted YYYY-MM-DDTHH:mm:ss.SSSZ`,
    );
  });
});

describe('SHA-256 digests', () => {
  it('digests exact bytes as lowercase hex', () => {
    assert.equal(sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    assert.equal(
      sha256Hex(new TextEncoder().encode('abc')),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('recognizes only 64 lowercase hex digits', () => {
    assert.equal(isSha256Hex('a'.repeat(64)), true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 64]) {
      assert.equal(isSha256Hex(bad), false, String(bad));
    }
  });
});

describe('decimal aggregates', () => {
  it('recognizes canonical nonnegative decimal strings', () => {
    assert.equal(isDecimalString('0'), true);
    assert.equal(isDecimalString('20000'), true);
    for (const bad of ['', '01', '-1', '1.0', ' 1', 1, '1e3']) {
      assert.equal(isDecimalString(bad), false, String(bad));
    }
  });

  it('sums safe-integer amounts exactly, beyond the double range', () => {
    assert.equal(sumMinorUnits([]), '0');
    assert.equal(sumMinorUnits([10000, 10000]), '20000');
    assert.equal(sumMinorUnits([0, 9007199254740991, 9007199254740991]), '18014398509481982');
  });

  it('refuses amounts that are not nonnegative safe integers', () => {
    for (const bad of [-1, 1.5, 9007199254740992, Number.NaN]) {
      assert.throws(() => sumMinorUnits([bad]), new RegExp(`amount ${String(bad)} is not a nonnegative safe integer`));
    }
  });

  it('compares decimal strings numerically and rejects malformed ones', () => {
    assert.equal(compareDecimal('20000' as DecimalString, '10000' as DecimalString), 1);
    assert.equal(compareDecimal('9' as DecimalString, '10' as DecimalString), -1);
    assert.equal(compareDecimal('18014398509481982' as DecimalString, '18014398509481982' as DecimalString), 0);
    assert.throws(() => compareDecimal('01' as DecimalString, '1' as DecimalString), /"01" is not a decimal string/);
    assert.throws(() => compareDecimal('1' as DecimalString, '-1' as DecimalString), /"-1" is not a decimal string/);
  });

  it('renders monotonic elapsed time and refuses a reading before the origin', () => {
    assert.equal(elapsedNs(1_000n, 3_000_001_000n), '3000000000');
    assert.equal(elapsedNs(5n, 5n), '0');
    assert.throws(() => elapsedNs(10n, 9n), /monotonic reading 9 precedes origin 10; expected now >= origin/);
  });

  it('computes signed millisecond differences of UTC instants', () => {
    const at = (text: string): UtcMillis => text as UtcMillis;
    assert.equal(signedDifferenceMs(at('2026-10-05T00:00:03.000Z'), at('2026-10-05T00:00:02.000Z')), '1000');
    assert.equal(signedDifferenceMs(at('2026-10-05T00:00:02.000Z'), at('2026-10-05T00:00:03.000Z')), '-1000');
    assert.equal(signedDifferenceMs(at('2026-10-05T00:00:02.000Z'), at('2026-10-05T00:00:02.000Z')), '0');
    assert.throws(
      () => signedDifferenceMs(at('2026-10-05T00:00:02Z'), at('2026-10-05T00:00:02.000Z')),
      /"2026-10-05T00:00:02Z" is not a UTC millis timestamp/,
    );
    assert.throws(
      () => signedDifferenceMs(at('2026-10-05T00:00:02.000Z'), at('later')),
      /"later" is not a UTC millis timestamp/,
    );
  });
});

// The one definition the hand-written guards of four packages share (M0 chores); it must stay
// the catalogue's `nonempty_trimmed` pattern as Ajv compiles it.
describe('nonempty-trimmed strings', () => {
  it('is the _defs nonempty_trimmed pattern with the u flag', () => {
    const defs = JSON.parse(readFileSync(join(DEFAULT_SCHEMA_ROOT, '_defs.schema.json'), 'utf8')) as {
      readonly $defs: { readonly nonempty_trimmed: { readonly pattern: string } };
    };
    assert.equal(NONEMPTY_TRIMMED_PATTERN.source, defs.$defs.nonempty_trimmed.pattern);
    assert.equal(NONEMPTY_TRIMMED_PATTERN.flags, 'u');
  });

  it('accepts a nonempty string without edge whitespace or inner line terminators', () => {
    for (const good of ['a', 'provider-1', 'two words', 'tab\tinside', '\u{1F600}']) {
      assert.equal(NONEMPTY_TRIMMED_PATTERN.test(good), true, JSON.stringify(good));
    }
    for (const bad of ['', ' ', ' a', 'a ', '\ta', 'a\n', 'a\nb', 'a\u2028b', '\u00a0a', 'a\ufeff']) {
      assert.equal(NONEMPTY_TRIMMED_PATTERN.test(bad), false, JSON.stringify(bad));
    }
  });
});
