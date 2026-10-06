// Totality of the golden harness readers over fault-injected fixture content (Owner amendment
// A-05, testing rule 6; WP-09 single-pass review): a case's fault can put any JSON in any member,
// so the expected-value matcher, the integrity checks and the §8.12 re-derivation return a result
// for values nested past the call stack, non-finite numbers and member names that shadow inherited
// ones, and every message they write stays bounded whatever the input size.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { deriveSettlement } from '../../golden/_harness/fixture-observations.ts';
import { expectedMismatches } from '../../golden/_harness/golden-harness.ts';
import { fixtureIntegrityProblems } from '../../support/golden-builder/fixture-integrity.ts';
import { parsedJson, towerText } from '../../support/kernel/deep-json.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const validator = createRecordValidator();
const encoder = new TextEncoder();

// One quoted value or path: the kernel limit plus its truncation marker.
const QUOTED_MAX = QUOTED_JSON_LIMIT + '…[truncated]'.length;
// A mismatch quotes a path and at most two values around under 40 characters of fixed text.
const MISMATCH_MAX = 3 * QUOTED_MAX + 40;
// An integrity problem quotes a few bounded parts and at most three bounded schema violations.
const PROBLEM_MAX = 4096;

const hostileKey = fc.constantFrom('__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'length');

// JSON text a fixture member can hold: ordinary values, objects whose members shadow inherited
// names, and towers deeper than the call stack.
const parsableText: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.jsonValue().map((value) => JSON.stringify(value)), weight: 8 },
  {
    arbitrary: fc
      .uniqueArray(fc.tuple(hostileKey, fc.jsonValue({ maxDepth: 2 })), { selector: ([key]) => key, maxLength: 3 })
      .map((members) => `{${members.map(([key, value]) => `"${key}":${JSON.stringify(value)}`).join(',')}}`),
    weight: 2,
  },
  {
    arbitrary: fc
      .record({
        shape: fc.constantFrom<TowerShape>('array', 'object', 'mixed'),
        depth: fc.integer({ min: 2_500, max: 20_000 }),
      })
      .map(({ shape, depth }) => towerText(shape, depth, '1')),
    weight: 1,
  },
);
// Fixture bytes may also hold numbers that overflow a double, which the kernel parser refuses.
const valueText: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: parsableText, weight: 11 },
  { arbitrary: fc.constantFrom('1e400', '-1e400', '[1e400]', '{"a":-1e400}'), weight: 1 },
);
// Parsed values, plus the non-finite numbers that only a case module's own values can carry.
const fixtureValue: fc.Arbitrary<JsonValue> = fc.oneof(
  { arbitrary: parsableText.map((text) => parsedJson(text)), weight: 11 },
  { arbitrary: fc.constantFrom<JsonValue>(Infinity, -Infinity, [Infinity], { a: -Infinity }), weight: 1 },
);

function objectText(members: readonly (readonly [string, string])[]): string {
  return `{${members.map(([key, text]) => `${JSON.stringify(key)}:${text}`).join(',')}}`;
}

const RECORD_MEMBERS = [
  'event_id',
  'source',
  'source_instance_id',
  'source_sequence',
  'causation_event_ids',
  'trial_id',
  'execution_manifest_sha256',
  'trial_manifest_sha256',
  'payment_sha256',
  'messages',
  'message_body_sha256',
  'toString',
] as const;
const recordTypeText = fc.oneof(
  fc.constantFrom('"dlq_snapshot"', '"trial_message_published"', '"dispatch_started"'),
  valueText,
);
const recordLine: fc.Arbitrary<string> = fc
  .record({
    record_type: recordTypeText,
    members: fc.uniqueArray(fc.tuple(fc.constantFrom(...RECORD_MEMBERS), valueText), {
      selector: ([key]) => key,
      maxLength: 6,
    }),
  })
  .map(({ record_type, members }) => objectText([['record_type', record_type], ...members]));
const fixtureFile = fc.record({
  path: fc.constantFrom('runner/runner-journal.jsonl', 'trials/t/journals/caller-journal.jsonl', 'trials/t/a.json'),
  lines: fc.array(fc.oneof({ arbitrary: recordLine, weight: 9 }, { arbitrary: valueText, weight: 1 }), {
    minLength: 1,
    maxLength: 4,
  }),
});

const T0 = Date.parse('2026-10-05T12:00:00.000Z');
const QUIET: JsonObject = {
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
};
const sample: fc.Arbitrary<JsonObject> = fc
  .record({
    seconds: fc.integer({ min: 0, max: 700 }),
    recheck: fc.boolean(),
    overrides: fc.uniqueArray(fc.tuple(fc.constantFrom('observed_at', ...Object.keys(QUIET)), fixtureValue), {
      selector: ([key]) => key,
      maxLength: 2,
    }),
  })
  .map(({ seconds, recheck, overrides }) => ({
    ...QUIET,
    observed_at: new Date(T0 + seconds * 1000).toISOString(),
    phase: recheck ? 'pre_freeze_recheck' : 'observation',
    ...Object.fromEntries(overrides),
  }));

describe('golden harness readers over hostile fixture content', () => {
  it('expectedMismatches is total, bounded and reflexive', () => {
    fc.assert(
      fc.property(fixtureValue, fixtureValue, (expected, actual) => {
        const mismatches = expectedMismatches(expected, actual);
        assert.ok(
          mismatches.every((message) => message.length <= MISMATCH_MAX),
          mismatches.map((message) => message.length).join(','),
        );
        assert.deepEqual(expectedMismatches(expected, expected), []);
      }),
      fuzzParameters(),
    );
  });

  it('fixtureIntegrityProblems is total and its problems are bounded', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fixtureFile, { selector: ({ path }) => path, maxLength: 2 }), (files) => {
        const bytes = new Map(files.map(({ path, lines }) => [path, encoder.encode(`${lines.join('\n')}\n`)]));
        const problems = fixtureIntegrityProblems(bytes, validator);
        assert.ok(
          problems.every((problem) => typeof problem === 'string' && problem.length <= PROBLEM_MAX),
          problems.map((problem) => problem.length).join(','),
        );
      }),
      fuzzParameters(),
    );
  });

  it('deriveSettlement is total and establishes only after a full window and a later recheck', () => {
    fc.assert(
      fc.property(fc.array(sample, { maxLength: 8 }), fc.integer({ min: 0, max: 700 }), (samples, deadline) => {
        const derived = deriveSettlement(samples, T0 + deadline * 1000);
        if (derived.status === 'not_established') {
          return;
        }
        const [start, established, rechecked] = [
          derived.window_start,
          derived.established_at,
          derived.rechecked_at,
        ].map((instant) => Date.parse(instant));
        assert.ok(start !== undefined && established !== undefined && rechecked !== undefined);
        assert.ok(established - start >= 120_000 && rechecked >= established, JSON.stringify(derived));
        assert.ok(rechecked <= T0 + deadline * 1000);
      }),
      fuzzParameters(),
    );
  });
});
