// The golden case contract (design §12.4): `defineGoldenCase` fills the omitted operations, and
// `parseGoldenCase` accepts a well-formed case and otherwise returns every problem — with its
// location, the offending value and the expected shape — for a closed root, ids, outcomes, the
// base, the plan, each operation and its selector, and non-JSON expectations. It never throws.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDER_REJECTION_REASONS } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { defineGoldenCase, parseGoldenCase, parsePlan } from '../../support/golden-builder/golden-case.ts';
import type { GoldenCase } from '../../support/golden-builder/golden-case.ts';
import { parseOperations, parseSelector } from '../../support/golden-builder/operation-parsing.ts';
import type { Problems } from '../../support/golden-builder/case-reading.ts';

const VALID = {
  case_id: 'conventional-control-pass',
  ac_ids: ['AC-RUA-001', 'AC-RUA-002'],
  rule_outcomes_reached: [{ rule_id: 'BR-RUA-001', outcome: 'pass' }],
  base: 'run-conventional-control',
  operations: [],
  expected: { verdict: 'pass', counts: [1, 2] },
} as const;

function problemsOf(value: unknown): readonly string[] {
  const parsed = parseGoldenCase(value);
  return parsed.ok ? [] : parsed.error;
}

describe('defineGoldenCase', () => {
  it('defaults operations to none and keeps everything else', () => {
    const defined = defineGoldenCase({ ...VALID, operations: undefined as never });
    assert.deepEqual(defined.operations, []);
    const withOperations = defineGoldenCase({ ...VALID, operations: [{ op: 'delete_file', path: 'a.json' }] });
    assert.deepEqual(withOperations.operations, [{ op: 'delete_file', path: 'a.json' }]);
  });
});

describe('parseGoldenCase', () => {
  it('accepts a well-formed case, with and without a plan', () => {
    assert.deepEqual(parseGoldenCase(VALID), { ok: true, value: VALID });
    const plan = {
      deliveries: [{ attempts: [{ behavior: 'succeeded', amount_minor: 5000, currency: 'USD' }] }],
      processing: 'completes',
    };
    const parsed = parseGoldenCase({ ...VALID, plan });
    assert.deepEqual(parsed.ok && parsed.value.plan, plan);
  });

  it('rejects a non-object and an open root', () => {
    assert.deepEqual(problemsOf(42), ['case is number 42; expected an object']);
    assert.deepEqual(problemsOf({ ...VALID, verdict: 'pass' }), [
      'case has unknown member "verdict"; expected only case_id, ac_ids, rule_outcomes_reached, base, operations, expected, plan',
    ]);
    const { expected: _, ...withoutExpected } = VALID;
    assert.deepEqual(problemsOf(withoutExpected), ['case.expected is missing; expected it to be present']);
  });

  it('reports bad ids, outcomes and base together', () => {
    const problems = problemsOf({
      ...VALID,
      case_id: 'Bad_Id',
      ac_ids: ['AC-RUA-1', 7],
      rule_outcomes_reached: [{ rule_id: '1x', outcome: 'Pass' }, 'pass', { rule_id: 'BR-RUA-001' }],
      base: 'toString',
    });
    assert.deepEqual(problems, [
      'case.case_id is string "Bad_Id"; expected a string matching /^[a-z0-9]+(-[a-z0-9]+)*$/',
      'case.ac_ids[0] is string "AC-RUA-1"; expected a string matching /^AC-RUA-\\d{3}$/',
      'case.ac_ids[1] is number 7; expected a string matching /^AC-RUA-\\d{3}$/',
      'case.rule_outcomes_reached[0].rule_id is string "1x"; expected a string matching /^[A-Za-z][A-Za-z0-9_-]*$/',
      'case.rule_outcomes_reached[0].outcome is string "Pass"; expected a string matching /^[a-z][a-z_]*$/',
      'case.rule_outcomes_reached[1] is string "pass"; expected an object',
      'case.rule_outcomes_reached[2].outcome is missing; expected it to be present',
      'case.base is string "toString"; expected one of run-conventional-control, run-durable-control, run-conventional-treatment, run-durable-treatment, validation-conventional-control, validation-conventional-treatment, validation-durable-control, validation-durable-treatment, probe',
    ]);
  });

  it('rejects repeated acceptance criteria and non-array lists', () => {
    assert.deepEqual(problemsOf({ ...VALID, ac_ids: ['AC-RUA-001', 'AC-RUA-001'] }), [
      'case.ac_ids ["AC-RUA-001","AC-RUA-001"] repeats an id; expected unique ids',
    ]);
    assert.deepEqual(problemsOf({ ...VALID, ac_ids: 'AC-RUA-001', rule_outcomes_reached: {} }), [
      'case.ac_ids is string "AC-RUA-001"; expected an array',
      'case.rule_outcomes_reached is object {}; expected an array',
    ]);
  });

  it('rejects expectations JSON cannot represent exactly', () => {
    for (const expected of [{ a: Number.NaN }, Number.POSITIVE_INFINITY, { a: undefined }, [(): number => 1]]) {
      const problems = problemsOf({ ...VALID, expected });
      assert.equal(problems.length, 1);
      assert.match(problems[0] ?? '', /^case\.expected is .*; expected a value JSON represents exactly$/);
    }
  });

  it('reads only own data members, never inherited ones', () => {
    const inherited = Object.create(VALID) as object;
    assert.equal(problemsOf(inherited).length, 6);
    const withAccessor = { ...VALID };
    Object.defineProperty(withAccessor, 'base', { get: () => 'probe', enumerable: true });
    assert.deepEqual(problemsOf(withAccessor), [
      'case.base is an accessor; expected a data property',
      'case.base is missing; expected it to be present',
    ]);
  });

  it('returns the typed case for the type the module declared', () => {
    const typed: GoldenCase = defineGoldenCase(VALID);
    assert.deepEqual(parseGoldenCase(typed), { ok: true, value: typed });
  });
});

describe('parsePlan', () => {
  it('reports the shape of deliveries, attempts and their values', () => {
    const problems: Problems = [];
    const plan = parsePlan(
      {
        deliveries: [
          {
            attempts: [{ behavior: 'exploded' }, { behavior: 'rejected', rejection_reason: 'NOPE', amount_minor: 1.5 }],
          },
          { attempts: 'none' },
          'x',
        ],
        processing: 'forever',
      },
      'case.plan',
      problems,
    );
    assert.equal(plan, undefined);
    assert.deepEqual(problems, [
      'case.plan.processing is string "forever"; expected one of completes, active_at_deadline',
      'case.plan.deliveries[0].attempts[0].behavior is string "exploded"; expected one of succeeded, targeted_timeout, safety_release, untargeted_timeout, rejected, commit_failed',
      `case.plan.deliveries[0].attempts[1].amount_minor is number 1.5; expected a safe integer of at least ${String(Number.MIN_SAFE_INTEGER)}`,
      `case.plan.deliveries[0].attempts[1].rejection_reason is string "NOPE"; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
      'case.plan.deliveries[1].attempts is string "none"; expected an array',
      'case.plan.deliveries[2] is string "x"; expected an object',
    ]);
  });

  it('keeps every optional attempt value and leaves architecture checks to build time', () => {
    const problems: Problems = [];
    const attempt = {
      behavior: 'rejected',
      amount_minor: -5,
      currency: 'brl',
      refund_request_id: ' ',
      payment_id: 'p',
      rejection_reason: 'PAYMENT_NOT_FOUND',
    };
    const plan = parsePlan({ deliveries: [{ attempts: [attempt] }], processing: 'active_at_deadline' }, 'p', problems);
    assert.deepEqual(problems, []);
    assert.deepEqual(plan, { deliveries: [{ attempts: [attempt] }], processing: 'active_at_deadline' });
  });

  it('rejects an attempt that is not an object and a truncate length below zero', () => {
    const problems: Problems = [];
    assert.equal(
      parsePlan({ deliveries: [{ attempts: ['succeeded'] }], processing: 'completes' }, 'p', problems),
      undefined,
    );
    assert.deepEqual(problems, ['p.deliveries[0].attempts[0] is string "succeeded"; expected an object']);
    const operationProblems: Problems = [];
    assert.equal(
      parseOperations([{ op: 'truncate', path: 'a.json', length: -1 }], 'ops', operationProblems),
      undefined,
    );
    assert.deepEqual(operationProblems, ['ops[0].length is number -1; expected a safe integer of at least 0']);
  });

  it('rejects a non-object plan and unknown attempt members', () => {
    const problems: Problems = [];
    assert.equal(parsePlan([], 'p', problems), undefined);
    assert.equal(
      parsePlan(
        { deliveries: [{ attempts: [{ behavior: 'succeeded', retries: 2 }] }], processing: 'completes' },
        'p',
        problems,
      ),
      undefined,
    );
    assert.equal(problems.length, 2);
    assert.match(problems[1] ?? '', /^p\.deliveries\[0\]\.attempts\[0\] has unknown member "retries"/);
  });
});

describe('parseOperations', () => {
  const parse = (operations: unknown): { readonly value: unknown; readonly problems: readonly string[] } => {
    const problems: Problems = [];
    return { value: parseOperations(operations, 'ops', problems), problems };
  };

  it('parses every operation kind', () => {
    const operations = [
      { op: 'set', path: '$trial/a.json', pointer: '/a', value: { b: [1] } },
      {
        op: 'set',
        path: 'x.jsonl',
        pointer: '/a',
        value: null,
        select: { record_type: 'dispatch_started', occurrence: 2 },
      },
      { op: 'remove', path: 'x.jsonl', pointer: '/a~1b', select: { event_id: 'e' } },
      { op: 'remove', path: 'a.json', pointer: '/a' },
      { op: 'remove_record', path: 'x.jsonl', select: { line: 3 } },
      { op: 'insert_record', path: 'x.jsonl', record: { a: 1 } },
      { op: 'insert_record', path: 'x.jsonl', record: { a: 1 }, after: { line: 1 } },
      { op: 'clone_record', path: 'x.jsonl', select: { line: 1 }, set: [{ pointer: '/a', value: 2 }] },
      { op: 'resequence', path: 'x.jsonl' },
      { op: 'put_file', path: 'n.json', content: { kind: 'json', record: { a: 1 } } },
      { op: 'put_file', path: 'n.jsonl', content: { kind: 'jsonl', records: [{ a: 1 }, 2] } },
      { op: 'delete_file', path: 'a.json' },
      { op: 'corrupt_byte', path: 'a.json', offset: 0, byte: 255 },
      { op: 'append_text', path: 'x.jsonl', text: '{"partial":' },
      { op: 'truncate', path: 'a.json', length: 0 },
    ];
    const parsed = parse(operations);
    assert.deepEqual(parsed.problems, []);
    const expected = operations.map((operation) =>
      operation.op === 'set' && 'select' in operation ? operation : operation,
    );
    assert.deepEqual(parsed.value, expected);
  });

  it('reports an unknown op, a member of another op, a bad path and a bad pointer', () => {
    const parsed = parse([
      { op: 'explode', path: 'a.json' },
      { op: 'delete_file', path: 'a.json', offset: 1 },
      { op: 'delete_file', path: ' a.json' },
      { op: 'set', path: 'a.json', pointer: 'a', value: 1 },
      { op: 'remove', path: 'a.json', pointer: 7 },
      'delete_file',
      { op: 'truncate', path: 'a.json', length: -1, colour: 'red' },
    ]);
    assert.equal(parsed.value, undefined);
    assert.deepEqual(parsed.problems, [
      'ops[0].op is string "explode"; expected one of set, remove, remove_record, insert_record, clone_record, resequence, put_file, delete_file, corrupt_byte, append_text, truncate',
      'ops[1] has unknown member "offset"; expected only op, path',
      'ops[2].path is string " a.json"; expected a string matching /^\\S(.*\\S)?$/u',
      `ops[3].pointer: pointer "a"; expected '' or a string starting with '/'`,
      'ops[4].pointer is number 7; expected a string matching /^[\\s\\S]*$/u',
      'ops[5] is string "delete_file"; expected an object',
      'ops[6] has unknown member "colour"; expected only op, path, length',
    ]);
  });

  it('reports bad selectors, assignments, contents and byte values', () => {
    const parsed = parse([
      { op: 'remove_record', path: 'x.jsonl', select: { line: 0 } },
      { op: 'remove_record', path: 'x.jsonl', select: { line: 1, event_id: 'e' } },
      { op: 'set', path: 'x.jsonl', pointer: '/a', value: 1, select: { record_type: 'Bad' } },
      { op: 'insert_record', path: 'x.jsonl', record: { a: Number.NaN }, after: {} },
      { op: 'clone_record', path: 'x.jsonl', select: { line: 1 }, set: [{ pointer: '/a' }, 'x'] },
      { op: 'clone_record', path: 'x.jsonl', select: { line: 1 }, set: 'x' },
      { op: 'put_file', path: 'n.json', content: { kind: 'json', records: [] } },
      { op: 'put_file', path: 'n.jsonl', content: { kind: 'jsonl', record: {} } },
      { op: 'put_file', path: 'n.jsonl', content: { kind: 'csv' } },
      { op: 'put_file', path: 'n.jsonl', content: { kind: 'jsonl', records: [Number.NaN] } },
      { op: 'put_file', path: 'n.jsonl', content: 'text' },
      { op: 'corrupt_byte', path: 'a.json', offset: -1, byte: 1.5 },
      { op: 'append_text', path: 'a.json', text: 1 },
    ]);
    assert.equal(parsed.value, undefined);
    assert.deepEqual(parsed.problems, [
      'ops[0].select.line is number 0; expected a safe integer of at least 1',
      'ops[1].select has members [event_id,line]; expected {record_type, occurrence?}, {event_id} or {line}',
      'ops[2].select.record_type is string "Bad"; expected a string matching /^[a-z][a-z0-9_]*$/',
      'ops[3].record is a non-JSON object; expected a value JSON represents exactly',
      'ops[3].after has members []; expected {record_type, occurrence?}, {event_id} or {line}',
      'ops[4].set[0].value is missing; expected it to be present',
      'ops[4].set[1] is string "x"; expected an object',
      'ops[5].set is string "x"; expected an array',
      'ops[6].content of kind json has records; expected one record',
      'ops[7].content of kind jsonl has record; expected records',
      'ops[8].content.kind is string "csv"; expected one of json, jsonl',
      'ops[9].content.records[0] is number NaN; expected a value JSON represents exactly',
      'ops[10].content is string "text"; expected an object',
      'ops[11].offset is number -1; expected a safe integer of at least 0',
      'ops[11].byte is number 1.5; expected a safe integer of at least 0',
      'ops[12].text is number 1; expected a string matching /^[\\s\\S]*$/u',
    ]);
  });

  it('rejects a non-array operations list', () => {
    assert.deepEqual(parse({}).problems, ['ops is object {}; expected an array']);
  });
});

describe('parseSelector', () => {
  it('defaults the occurrence to the first and rejects non-object selectors', () => {
    const problems: Problems = [];
    assert.deepEqual(parseSelector({ record_type: 'a' }, 's', problems), { record_type: 'a', occurrence: 1 });
    assert.deepEqual(parseSelector({ event_id: 'e' }, 's', problems), { event_id: 'e' });
    assert.equal(parseSelector({ event_id: 1 }, 's', problems), undefined);
    assert.equal(parseSelector({ record_type: 'a', occurrence: 0 }, 's', problems), undefined);
    assert.equal(parseSelector(null, 's', problems), undefined);
    assert.equal(parseSelector({ other: 1 }, 's', problems), undefined);
    assert.deepEqual(problems, [
      's.event_id is number 1; expected a string matching /^[\\s\\S]*$/u',
      's.occurrence is number 0; expected a safe integer of at least 1',
      's is null null; expected an object',
      's has unknown member "other"; expected only record_type, occurrence, event_id, line',
    ]);
  });
});
