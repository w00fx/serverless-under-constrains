// Totality of the golden case boundary (Owner amendments A-05, A-07; testing rule 6): whatever a
// case module exports — arbitrary values, values nested past the call stack, non-finite numbers,
// inherited member names, accessors — `parseGoldenCase` returns a result and never throws; a
// rejection always names at least one problem; an accepted case is a closed, JSON-exact value
// that parses again to itself. Operation lists of any shape behave the same way.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { parseGoldenCase } from '../../support/golden-builder/golden-case.ts';
import { parseOperations } from '../../support/golden-builder/operation-parsing.ts';
import type { Problems } from '../../support/golden-builder/case-reading.ts';
import { BASE_SCENARIO_IDS, ATTEMPT_BEHAVIORS } from '../../support/golden-builder/golden-plan.ts';
import { deepTowerArbitrary } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

// Member names that inherited lookups or assignment would treat specially.
const hostileKey = fc.constantFrom('__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'length');
const hostileScalar = fc.constantFrom<unknown>(
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  undefined,
  10n,
  Symbol('s'),
);
const anyValue: fc.Arbitrary<unknown> = fc.oneof(
  {
    arbitrary: fc.anything({
      withNullPrototype: true,
      withBigInt: true,
      withDate: true,
      withMap: true,
      withSparseArray: true,
    }),
    weight: 8,
  },
  { arbitrary: deepTowerArbitrary(), weight: 1 },
  { arbitrary: hostileScalar, weight: 2 },
  {
    arbitrary: fc
      .dictionary(hostileKey, fc.jsonValue())
      .map((entries) => JSON.parse(JSON.stringify(entries)) as unknown),
    weight: 2,
  },
);

const operationLike = fc.record(
  {
    op: fc.constantFrom(
      'set',
      'remove',
      'remove_record',
      'insert_record',
      'clone_record',
      'resequence',
      'put_file',
      'delete_file',
      'corrupt_byte',
      'append_text',
      'truncate',
      'toString',
    ),
    path: fc.oneof(fc.constantFrom('$trial/a.json', 'a.jsonl', '', ' x'), fc.string()),
    pointer: fc.oneof(fc.constantFrom('/a', '', '/~2', '/__proto__'), fc.string()),
    value: anyValue,
    select: fc.oneof(fc.record({ line: fc.integer() }), fc.record({ record_type: fc.string() }), anyValue),
    record: anyValue,
    set: fc.array(fc.record({ pointer: fc.string(), value: anyValue }), { maxLength: 3 }),
    content: fc.oneof(
      fc.record({ kind: fc.constantFrom('json', 'jsonl'), record: anyValue, records: fc.array(anyValue) }),
      anyValue,
    ),
    offset: fc.oneof(fc.integer(), anyValue),
    byte: fc.oneof(fc.integer({ min: -1, max: 256 }), anyValue),
    text: fc.oneof(fc.string(), anyValue),
    length: fc.oneof(fc.integer(), anyValue),
  },
  { requiredKeys: ['op'] },
);

const caseLike = fc.record(
  {
    case_id: fc.oneof(fc.constantFrom('a-b', 'Bad', ''), anyValue),
    ac_ids: fc.oneof(fc.array(fc.constantFrom('AC-RUA-001', 'AC-RUA-002', 'AC-1')), anyValue),
    rule_outcomes_reached: fc.oneof(fc.array(fc.record({ rule_id: fc.string(), outcome: fc.string() })), anyValue),
    base: fc.oneof(fc.constantFrom(...BASE_SCENARIO_IDS, 'toString'), anyValue),
    plan: fc.oneof(
      fc.record({
        deliveries: fc.array(
          fc.record({
            attempts: fc.array(
              fc.record(
                {
                  behavior: fc.constantFrom(...ATTEMPT_BEHAVIORS, 'x'),
                  amount_minor: fc.oneof(fc.integer(), anyValue),
                },
                { requiredKeys: ['behavior'] },
              ),
              { maxLength: 3 },
            ),
          }),
          { maxLength: 3 },
        ),
        processing: fc.constantFrom('completes', 'active_at_deadline', 'never'),
      }),
      anyValue,
    ),
    operations: fc.oneof(fc.array(operationLike, { maxLength: 4 }), anyValue),
    expected: anyValue,
    toString: anyValue,
  },
  { requiredKeys: [] },
);

describe('golden case parsing fuzz', () => {
  it('parseGoldenCase is total, names a problem for every rejection, and round-trips an accepted case', () => {
    fc.assert(
      fc.property(fc.oneof(caseLike, anyValue), (value) => {
        const parsed = parseGoldenCase(value);
        if (!parsed.ok) {
          assert.ok(parsed.error.length > 0);
          assert.ok(parsed.error.every((problem) => typeof problem === 'string' && problem.length > 0));
          return;
        }
        assert.deepEqual(parseGoldenCase(parsed.value), parsed);
        assert.equal(
          JSON.stringify(JSON.parse(JSON.stringify(parsed.value.expected))),
          JSON.stringify(parsed.value.expected),
        );
      }),
      fuzzParameters(),
    );
  });

  it('accepts every well-formed case, including hostile member names inside expected, and round-trips it', () => {
    const wellFormed = fc.record({
      case_id: fc.stringMatching(/^[a-z0-9]+(-[a-z0-9]+)*$/),
      ac_ids: fc.uniqueArray(
        fc.integer({ min: 1, max: 999 }).map((n) => `AC-RUA-${String(n).padStart(3, '0')}`),
        { maxLength: 4 },
      ),
      rule_outcomes_reached: fc.array(
        fc.record({
          rule_id: fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]*$/),
          outcome: fc.stringMatching(/^[a-z][a-z_]*$/),
        }),
        { maxLength: 3 },
      ),
      base: fc.constantFrom(...BASE_SCENARIO_IDS),
      operations: fc.constant([]),
      expected: fc.oneof(
        fc.jsonValue(),
        fc.dictionary(hostileKey, fc.jsonValue()).map((entries) => JSON.parse(JSON.stringify(entries)) as unknown),
      ),
    });
    fc.assert(
      fc.property(wellFormed, (value) => {
        const parsed = parseGoldenCase(value);
        assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.join('\n'));
        assert.deepEqual(parseGoldenCase(parsed.value), parsed);
      }),
      fuzzParameters(),
    );
  });

  it('parseOperations is total and reports a problem whenever it rejects', () => {
    fc.assert(
      fc.property(fc.oneof(fc.array(operationLike, { maxLength: 5 }), anyValue), (value) => {
        const problems: Problems = [];
        const parsed = parseOperations(value, 'ops', problems);
        assert.equal(parsed === undefined, problems.length > 0);
      }),
      fuzzParameters(),
    );
  });
});
