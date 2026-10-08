// The golden harness helpers every feature's golden tests use: the partial expected-value matcher,
// reading records out of fixture bytes, and the independent §8.12 settlement derivation the base
// goldens hold the runner's assessment to (design §8.12, BR-RUA-032).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { deriveSettlement, observeSubject } from '../../golden/_harness/fixture-observations.ts';
import { expectedMismatches, fixtureRecords } from '../../golden/_harness/golden-harness.ts';
import { defineGoldenCase } from '../../support/golden-builder/golden-case.ts';
import { DEEP_NESTING, parsedJson, parsedTower, towerText } from '../../support/kernel/deep-json.ts';

const encoder = new TextEncoder();
const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();

function quietSample(seconds: number, overrides: JsonObject = {}): JsonObject {
  return {
    observed_at: at(seconds),
    phase: 'observation',
    publication_stopped: true,
    processing_terminal: true,
    inner_executions_terminal: 'not_applicable',
    provider_active_calls: 0,
    provider_held_barriers: 0,
    provider_pending_releases: 0,
    treatment_terminal: true,
    ledger_snapshot_possible: true,
    source_queue: { visible: 0, in_flight: 0, delayed: 0 },
    dlq: { visible: 0, in_flight: 0, delayed: 0 },
    correlated_dlq_message_ids: [],
    dlq_captured_message_ids: [],
    correlated_event_watermark: 10,
    ledger_item_count: 1,
    ...overrides,
  };
}

const quietRun = (from: number, count: number): readonly JsonObject[] =>
  Array.from({ length: count }, (_, index) => quietSample(from + index * 30));
const recheck = (seconds: number, overrides: JsonObject = {}): JsonObject =>
  quietSample(seconds, { phase: 'pre_freeze_recheck', ...overrides });

describe('expectedMismatches', () => {
  it('matches named members only, arrays by length and item, scalars exactly', () => {
    assert.deepEqual(
      expectedMismatches({ a: 1, b: [1, { c: 'x' }] }, { a: 1, b: [1, { c: 'x', d: 2 }], extra: true }),
      [],
    );
    assert.deepEqual(expectedMismatches({ verdict: 'pass' }, { verdict: 'fail', extra: 1 }), [
      '$.verdict: expected "pass", got "fail"',
    ]);
    assert.deepEqual(expectedMismatches(null, null), []);
  });

  it('reports wrong shapes, lengths, absent members and inherited names, sorted', () => {
    assert.deepEqual(expectedMismatches({ z: [1, 2], a: { b: 1 }, m: null, toString: 1 }, { z: [1], a: [1], m: 0 }), [
      '$.a: expected an object, got [1]',
      '$.m: expected null, got 0',
      '$.toString: expected 1, got undefined',
      '$.z: expected an array of 2, got [1]',
    ]);
    assert.deepEqual(expectedMismatches([1], undefined), ['$: expected an array of 1, got undefined']);
    assert.deepEqual(expectedMismatches({ a: 1 }, 'text'), ['$: expected an object, got "text"']);
  });

  it('compares values nested past the call stack', () => {
    assert.deepEqual(expectedMismatches(parsedTower('mixed', DEEP_NESTING), parsedTower('mixed', DEEP_NESTING)), []);
    assert.equal(
      expectedMismatches(parsedTower('array', DEEP_NESTING), parsedTower('array', DEEP_NESTING - 1)).length,
      1,
    );
  });

  // A-05 regression (WP-09 single-pass review): JSON.stringify threw RangeError quoting a value
  // nested past the call stack, wrote Infinity as null, and copied any length into the message.
  it('quotes deep, long and non-finite values and long paths in bounded messages', () => {
    const towerQuote = '\\[{200}…\\[truncated\\]';
    const deep = parsedTower('array', DEEP_NESTING);
    assert.match(expectedMismatches(1, deep).join('\n'), new RegExp(`^\\$: expected 1, got ${towerQuote}$`));
    assert.match(
      expectedMismatches([1, 2], deep).join('\n'),
      new RegExp(`^\\$: expected an array of 2, got ${towerQuote}$`),
    );
    assert.match(
      expectedMismatches({ a: 1 }, deep).join('\n'),
      new RegExp(`^\\$: expected an object, got ${towerQuote}$`),
    );
    const [nested = ''] = expectedMismatches(deep, parsedTower('array', DEEP_NESTING - 1));
    assert.match(nested, /^\$(\[0\]){66}\[…\[truncated\]: expected an array of 1, got 1$/);
    assert.deepEqual(expectedMismatches({ a: 1 }, { a: Infinity }), ['$.a: expected 1, got Infinity']);
    assert.deepEqual(expectedMismatches('x', 'y'.repeat(1000)), [
      `$: expected "x", got "${'y'.repeat(199)}…[truncated]`,
    ]);
    assert.deepEqual(expectedMismatches({ ['k'.repeat(1000)]: 1 }, parsedJson('{"valueOf":1}')), [
      `$.${'k'.repeat(198)}…[truncated]: expected 1, got undefined`,
    ]);
  });
});

describe('fixtureRecords', () => {
  it('reads JSONL lines and a JSON document', () => {
    const files = new Map([
      ['a.jsonl', encoder.encode('{"a":1}\n{"a":2}\n')],
      ['b.json', encoder.encode('{"b":1}\n')],
    ]);
    assert.deepEqual(fixtureRecords(files, 'a.jsonl'), [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(fixtureRecords(files, 'b.json'), [{ b: 1 }]);
  });

  it('throws for an absent file or a non-record line, naming it', () => {
    const files = new Map([['bad.jsonl', encoder.encode('{"a":1}\n[1]\n')]]);
    assert.throws(
      () => fixtureRecords(files, 'none.json'),
      /the fixture has no none\.json; expected the file to exist/,
    );
    assert.throws(
      () => fixtureRecords(files, 'bad.jsonl'),
      /bad\.jsonl: a line or document is not a JSON object; expected a record/,
    );
  });
});

describe('observeSubject', () => {
  const golden_case = defineGoldenCase({
    case_id: 'x',
    ac_ids: [],
    rule_outcomes_reached: [],
    base: 'probe',
    expected: null,
  });
  const state = (version: string, reason: string): string =>
    `{"record_type":"request_state_recorded","version":${version},"processing_state":"FINISHED","processing_terminal_reason":"${reason}"}\n`;
  const lastReason = (journal: string): JsonValue | undefined =>
    observeSubject({
      golden_case,
      case_file: '',
      fixture_file: '',
      files: new Map([
        ['probe/journals/caller-journal.jsonl', encoder.encode(journal)],
        ['runner/runner-journal.jsonl', new Uint8Array()],
      ]),
      subject_directory: 'probe',
    })['processing_terminal_reason'];

  // A-05 regression (WP-09 single-pass review): ordering request states by `Number(version)` threw
  // on a version that defeats coercion or is nested past the call stack, and a NaN version made
  // the comparison inconsistent. A state without a numeric version now sorts first, in file order.
  it('orders request states by numeric version, unversioned first, without throwing', () => {
    const hostile = '{"valueOf":1,"toString":1}';
    const deep = towerText('array', DEEP_NESTING, '1');
    assert.equal(lastReason(state(hostile, 'first') + state(deep, 'last')), 'last');
    assert.equal(
      lastReason(state(hostile, 'a') + state('2', 'two') + state(deep, 'b') + state('1', 'one') + state('"3"', 'c')),
      'two',
    );
  });
});

describe('deriveSettlement (§8.12)', () => {
  const deadline = T0 + 600_000;

  it('establishes after 120 s of quiet observation and a quiet recheck', () => {
    const samples = [...quietRun(30, 5), recheck(155)];
    assert.deepEqual(deriveSettlement(samples, deadline), {
      status: 'established',
      window_start: at(30),
      established_at: at(150),
      rechecked_at: at(155),
    });
  });

  it('orders samples by observed_at before evaluating', () => {
    const samples = [recheck(155), ...quietRun(30, 5).toReversed()];
    assert.equal(deriveSettlement(samples, deadline).status, 'established');
  });

  it('does not establish without a recheck, or with a recheck before the window completes', () => {
    assert.deepEqual(deriveSettlement(quietRun(30, 10), deadline), { status: 'not_established' });
    assert.deepEqual(deriveSettlement([...quietRun(30, 4), recheck(125)], deadline), { status: 'not_established' });
  });

  it('restarts the window on each kind of activity', () => {
    const activities: readonly JsonObject[] = [
      { publication_stopped: false },
      { processing_terminal: false },
      { inner_executions_terminal: false },
      { provider_active_calls: 1 },
      { provider_held_barriers: 1 },
      { provider_pending_releases: 1 },
      { treatment_terminal: false },
      { ledger_snapshot_possible: false },
      { source_queue: { visible: 0, in_flight: 1, delayed: 0 } },
      { source_queue: 'unavailable' },
      { dlq: { visible: 1, in_flight: 0, delayed: 0 } },
      { correlated_dlq_message_ids: ['m'] },
      { correlated_event_watermark: 11 },
      { ledger_item_count: 2 },
    ];
    for (const activity of activities) {
      const samples = [...quietRun(30, 4), quietSample(150, activity), recheck(155, activity)];
      assert.deepEqual(deriveSettlement(samples, deadline), { status: 'not_established' }, JSON.stringify(activity));
      const later = [
        quietSample(30, activity),
        ...quietRun(60, 5).map((sample) => ({ ...sample, ...lasting(activity) })),
        recheck(185, lasting(activity)),
      ];
      assert.equal(deriveSettlement(later, deadline).status, 'established', `${JSON.stringify(activity)} then quiet`);
    }
  });

  it('accepts not-applicable markers and a captured DLQ message as quiet', () => {
    const marker = { source_queue: 'not_applicable', dlq: 'not_applicable', treatment_terminal: 'not_applicable' };
    const captured = {
      dlq: { visible: 1, in_flight: 0, delayed: 0 },
      correlated_dlq_message_ids: ['m'],
      dlq_captured_message_ids: ['m'],
    };
    for (const overrides of [marker, captured]) {
      const samples = [...quietRun(30, 5).map((sample) => ({ ...sample, ...overrides })), recheck(155, overrides)];
      assert.equal(deriveSettlement(samples, deadline).status, 'established', JSON.stringify(overrides));
    }
  });

  it('a new correlated DLQ id is activity even once captured', () => {
    const before = { correlated_dlq_message_ids: [], dlq_captured_message_ids: [] };
    const after = { correlated_dlq_message_ids: ['m'], dlq_captured_message_ids: ['m'] };
    const samples = [...quietRun(30, 5).map((sample) => ({ ...sample, ...before })), recheck(155, after)];
    assert.equal(deriveSettlement(samples, deadline).status, 'not_established');
  });

  // A-05 regression (WP-09 single-pass review): `Number()` threw on a counter or watermark that
  // defeats coercion or is nested past the call stack. A counter that is not a number is not a
  // count, so never quiet; a watermark that is not a number never advances, as an absent one.
  it('reads non-number counters as never quiet and watermarks as no advance, without throwing', () => {
    const hostile = [parsedJson('{"valueOf":1,"toString":1}'), parsedTower('array', DEEP_NESTING), '0'];
    for (const value of hostile) {
      const counter = { source_queue: { visible: value, in_flight: 0, delayed: 0 } };
      const counted = [...quietRun(30, 5).map((sample) => ({ ...sample, ...counter })), recheck(155, counter)];
      assert.deepEqual(deriveSettlement(counted, deadline), { status: 'not_established' });
      const watermark = { correlated_event_watermark: value };
      const watched = [...quietRun(30, 5).map((sample) => ({ ...sample, ...watermark })), recheck(155, watermark)];
      assert.equal(deriveSettlement(watched, deadline).status, 'established');
    }
  });

  // Fuzz regression (seed 20261006, path 9364:3:1:2:6:5:6:6:8:8:11:11:13:12:12:15:16:13:12:13:13,
  // minimized): a sample whose observed_at is not an instant made the ordering inconsistent, so
  // the recheck at 0 s sorted after the window that closed at 120 s and settlement was established.
  it('drops samples without a readable instant before ordering the rest', () => {
    const unreadable = { ...quietSample(60), observed_at: [] };
    const samples = [quietSample(0), quietSample(120), unreadable, recheck(0)];
    assert.deepEqual(deriveSettlement(samples, deadline), { status: 'not_established' });
  });

  it('ignores samples after the deadline', () => {
    const samples = [...quietRun(30, 5), recheck(155)];
    assert.equal(deriveSettlement(samples, T0 + 154_000).status, 'not_established');
  });
});

// The value a once-active member keeps when the next samples are quiet: counters and the
// watermark stay where activity left them, every flag returns to quiet.
function lasting(activity: JsonObject): JsonObject {
  const keys = ['correlated_event_watermark', 'ledger_item_count', 'correlated_dlq_message_ids'];
  const kept: JsonObject = Object.fromEntries(Object.entries(activity).filter(([key]) => keys.includes(key)));
  return Object.hasOwn(activity, 'correlated_dlq_message_ids') ? { ...kept, dlq_captured_message_ids: ['m'] } : kept;
}
