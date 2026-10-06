// AC-RUA-046 serialization rules (BR-RUA-033) and the A-02 hostile-value regressions, proven
// through the public validation contract against the REAL merged catalogue (groups A-C, loaded
// from disk by the node filesystem adapter) and the canonical examples its packages publish.
// Each case asserts a rule the spec states for the record it edits: lowercase UUIDv4 only for
// generated identifiers (BR-RUA-033's list, which does not include payment_id), uppercase domain
// and lifecycle enums, lowercase verdicts, and null only where absence has meaning (WP-00 review
// round 1: the former fixture catalogue reused real record_type names with invented shapes).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../src/record-contract/schema-registry.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';
import { CANONICAL_EXAMPLES as GROUP_A } from './group-a/support/canonical-examples.ts';
import { CANONICAL_EXAMPLES as GROUP_B } from './group-b/examples/group-b-examples.ts';
import { toJson } from './group-b/support/record-builders.ts';
import { CANONICAL_EXAMPLES as GROUP_C } from './group-c/examples/group-c-examples.ts';
import { indeterminateOracleResult } from './group-c/examples/oracle-examples.ts';

const validator = createRecordValidator();
const LOWER_V4 = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f';
/** The minimized counterexample WP-03 promoted (A-02): valid JSON with no primitive conversion. */
const HOSTILE_TEXT = '{"toString":1,"valueOf":1}';
const REFERENCE_MEMBERS = [
  'artifact_path',
  'artifact_sha256',
  'event_id',
  'json_pointer',
  'package_index_sha256',
] as const;

/** Member names every JSON object inherits; JSON.parse makes each one an own member (A-05, A-07). */
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf'] as const;
/**
 * The root closure finding of an unknown member. Group B closes its roots with
 * `unevaluatedProperties` until WP-02's Owner amendment A-07 fix merges; the A-07 integration
 * step then leaves only `additionalProperties` (design §6) and the registry refuses the other.
 */
const ROOT_CLOSURE_FINDINGS: readonly string[] = [' additionalProperties', ' unevaluatedProperties'];

const payment = (): JsonObject => GROUP_A.payment();
const dispatchStarted = (): JsonObject => toJson(GROUP_B.dispatch_started());
const oracleResult = (): JsonObject => toJson(GROUP_C.oracle_result());
const billingImport = (): JsonObject => toJson(GROUP_C.billing_import());

/** A copy of `record` with the value at `path` replaced (`value` itself is not copied). */
function edited(record: JsonObject, path: readonly (string | number)[], value: JsonValue): JsonObject {
  const last = path.at(-1);
  if (last === undefined) {
    throw new Error('edited needs a non-empty path; got []');
  }
  const copy = structuredClone(record);
  const parent = path.slice(0, -1).reduce<JsonValue>((node, step) => (node as JsonObject)[step] as JsonValue, copy);
  (parent as Record<string | number, JsonValue>)[last] = value;
  return copy;
}

function hostile(): JsonValue {
  return JSON.parse(HOSTILE_TEXT) as JsonValue;
}

function violationsOf(record: JsonValue): readonly string[] {
  let result: RecordValidation;
  try {
    result = validator.validate(record);
  } catch (error) {
    return assert.fail(`validate threw ${String(error)}; expected findings`);
  }
  return result.valid ? [] : result.violations.map((violation) => `${violation.instance_path} ${violation.keyword}`);
}

function assertRejected(record: JsonObject, expected: string, label: string): void {
  const found = violationsOf(record);
  assert.ok(found.includes(expected), `${label}: expected violation "${expected}", got ${JSON.stringify(found)}`);
}

function assertAccepted(record: JsonObject, label: string): void {
  assert.deepEqual(violationsOf(record), [], label);
}

describe('AC-RUA-046 serialization rules', () => {
  it('casing', () => {
    assertAccepted(payment(), 'snake_case record');
    assertRejected({ ...payment(), paymentId: 'pay-poc-001' }, ' additionalProperties', 'camelCase field');
    const camelEvent = violationsOf({ ...dispatchStarted(), attemptId: LOWER_V4 });
    assert.ok(
      camelEvent.some((found) => ROOT_CLOSURE_FINDINGS.includes(found)),
      `camelCase event field: expected a root closure finding, got ${JSON.stringify(camelEvent)}`,
    );
    assert.deepEqual(violationsOf({ ...payment(), record_type: 'Payment' }), ['/record_type record_type']);
    // Domain and lifecycle enum values stay uppercase.
    assertRejected({ ...payment(), currency: 'brl' }, '/currency const', 'lowercase currency');
    assertRejected({ ...oracleResult(), scenario: 'control' }, '/scenario enum', 'lowercase scenario');
    assertRejected(
      { ...oracleResult(), processing_terminal_reason: 'succeeded' },
      '/processing_terminal_reason enum',
      'lowercase lifecycle reason',
    );
    // Verdict, validity and eligibility values stay lowercase.
    assertRejected({ ...oracleResult(), preservation_verdict: 'PASS' }, '/preservation_verdict enum', 'verdict');
    assertRejected({ ...oracleResult(), trial_validity: 'VALID' }, '/trial_validity enum', 'validity');
    assertRejected(
      edited(oracleResult(), ['validity_gates', 0, 'value'], 'VERIFIED'),
      '/validity_gates/0/value enum',
      'gate',
    );
    const reason = { code: 'missing_artifact', subject: 'ledger', detail: 'absent' };
    assertRejected(
      edited(oracleResult(), ['indeterminate_reasons'], [reason]),
      '/indeterminate_reasons/0/code pattern',
      'lowercase reason code',
    );
  });

  it('millisecond UTC', () => {
    assertAccepted({ ...dispatchStarted(), occurred_at: '2026-10-05T23:59:59.999Z' }, 'millisecond UTC instant');
    for (const value of [
      '2026-10-05T12:00:00Z',
      '2026-10-05T12:00:00.000123Z',
      '2026-10-05T12:00:00.000+00:00',
      '2026-10-05T12:00:00.000z',
    ]) {
      assertRejected({ ...dispatchStarted(), occurred_at: value }, '/occurred_at pattern', value);
    }
    assertRejected({ ...dispatchStarted(), dispatch_at: '2026-02-30T12:00:00.000Z' }, '/dispatch_at format', 'Feb 30');
    assertRejected({ ...dispatchStarted(), deadline_at: 1791230400000 }, '/deadline_at type', 'epoch number');
  });

  it('lowercase UUIDv4', () => {
    // BR-RUA-033 lists the generated identifiers; payment_id is an input name, not one of them.
    assertAccepted({ ...dispatchStarted(), attempt_id: LOWER_V4 }, 'lowercase v4 attempt id');
    assertAccepted({ ...payment(), payment_id: 'pay-poc-001' }, 'CTR-RUA-005 payment_id is not a UUID');
    const generated = ['event_id', 'run_id', 'attempt_id', 'provider_request_id', 'source_instance_id'] as const;
    const malformed: readonly [string, string][] = [
      [LOWER_V4.toUpperCase(), 'uppercase'],
      ['3f1c2a9e-8b4d-1c1e-9f00-1a2b3c4d5e6f', 'version 1'],
      ['3f1c2a9e-8b4d-4c1e-cf00-1a2b3c4d5e6f', 'wrong variant'],
      ['3f1c2a9e8b4d4c1e9f001a2b3c4d5e6f', 'unhyphenated'],
    ];
    for (const field of generated) {
      for (const [value, label] of malformed) {
        assertRejected({ ...dispatchStarted(), [field]: value }, `/${field} pattern`, `${field} ${label}`);
      }
    }
    assertRejected({ ...dispatchStarted(), causation_event_ids: ['ABC'] }, '/causation_event_ids/0 pattern', 'cause');
  });

  it('safe-integer amounts', () => {
    assertAccepted({ ...payment(), captured_amount_minor: 9007199254740991 }, 'max safe integer');
    const integral = parseJsonDocument(
      new TextEncoder().encode(
        '{"schema_version":1,"record_type":"payment","payment_id":"pay-poc-001","captured_amount_minor":1.0,"currency":"BRL"}',
      ),
    );
    assert.ok(integral.ok);
    assertAccepted(integral.value as JsonObject, 'integral JSON number 1.0');
    assertRejected({ ...payment(), captured_amount_minor: 9007199254740992 }, '/captured_amount_minor maximum', '2^53');
    assertRejected({ ...payment(), captured_amount_minor: 0 }, '/captured_amount_minor minimum', 'zero');
    assertRejected({ ...payment(), captured_amount_minor: 100.5 }, '/captured_amount_minor type', 'fraction');
    assertRejected({ ...payment(), captured_amount_minor: '10000' }, '/captured_amount_minor type', 'string');
    assertRejected({ ...dispatchStarted(), source_sequence: 0 }, '/source_sequence minimum', 'sequence starts at 1');
  });

  it('decimal aggregates', () => {
    const total = ['monetary_observations', 'refunded_total_minor'] as const;
    assertAccepted(edited(oracleResult(), total, '18014398509481982'), 'aggregate beyond 2^53');
    for (const value of ['01', '-1', '1.0', ' 1', '1e3', '']) {
      assertRejected(edited(oracleResult(), total, value), `/${total.join('/')} pattern`, `aggregate ${value}`);
      assertRejected({ ...dispatchStarted(), deadline_ns: value }, '/deadline_ns pattern', `elapsed ns ${value}`);
    }
    assertRejected(edited(oracleResult(), total, 2500), `/${total.join('/')} type`, 'number aggregate');
    assertAccepted({ ...billingImport(), attributed_total_usd: '0.0000166667' }, 'money decimal');
    assertRejected(
      { ...billingImport(), attributed_total_usd: '.5' },
      '/attributed_total_usd pattern',
      'no integer part',
    );
  });

  it('omitted versus null', () => {
    // Absence has explicit meaning for an indeterminate verdict: no completion judgment and no
    // terminal reason (BR-RUA-030, D-17), so null is required there and refused elsewhere.
    const indeterminate = toJson(indeterminateOracleResult());
    assertAccepted(indeterminate, 'null where absence has meaning');
    assertRejected({ ...indeterminate, correct_completion: false }, '/correct_completion const', 'indeterminate');
    assertRejected({ ...oracleResult(), correct_completion: null }, '/correct_completion const', 'null on a pass');
    const { correct_completion: _omitted, ...withoutCompletion } = indeterminate;
    assertRejected(withoutCompletion, ' required', 'meaningful null is never omitted');
    // An optional property without meaning is omitted, never written as null or as an empty list.
    assertRejected({ ...dispatchStarted(), trial_id: null }, '/trial_id type', 'optional trial id as null');
    assertRejected({ ...dispatchStarted(), causation_event_ids: [] }, '/causation_event_ids minItems', 'empty causes');
    const { trial_manifest_sha256: _digest, ...withoutDigest } = dispatchStarted();
    assertRejected(withoutDigest, ' dependentRequired', 'trial_id without its manifest digest');
    assertAccepted(
      { ...dispatchStarted(), causation_event_ids: [LOWER_V4, 'ffffffff-ffff-4fff-bfff-ffffffffffff'] },
      'causes',
    );
    const withUndefined = { ...payment(), note: undefined } as unknown as StudyRecord;
    assert.throws(() => serializeRecordFile(withUndefined), /value at \$\.note is of type undefined/);
  });

  // WP-00 review round 2 (A-05 item 3, A-07): JSON.parse turns an inherited member name into an
  // own member, which a closed record must refuse like any other unknown property.
  it('an inherited member name is an unknown property of a closed record', () => {
    const text = new TextDecoder().decode(serializeRecordFile(payment() as unknown as StudyRecord)).trim();
    for (const name of INHERITED_NAMES) {
      const parsed = parseJsonDocument(new TextEncoder().encode(`${text.slice(0, -1)},${JSON.stringify(name)}:1}`));
      assert.ok(parsed.ok, name);
      assert.deepEqual(violationsOf(parsed.value), [' additionalProperties'], name);
    }
  });

  it('schema_version and record_type present', () => {
    const { schema_version: _version, ...withoutVersion } = payment();
    assertRejected(withoutVersion, ' required', 'missing schema_version');
    assertRejected({ ...payment(), schema_version: 2 }, '/schema_version const', 'unknown schema_version');
    const { record_type: _type, ...withoutType } = payment();
    assert.deepEqual(violationsOf(withoutType), ['/record_type record_type']);
    const { schema_version: _v, record_type: _t, ...bareEvent } = dispatchStarted();
    const asType = validator.validateAs('dispatch_started', bareEvent);
    assert.deepEqual(asType.valid ? [] : asType.violations.map((v) => `${v.instance_path} ${v.keyword}`), [
      '/record_type record_type',
    ]);
    const { run_id: _run, ...withoutIdentity } = dispatchStarted();
    assertRejected(withoutIdentity, ' oneOf', 'no execution identity');
    assertRejected({ ...dispatchStarted(), transport_probe_id: LOWER_V4 }, ' oneOf', 'two execution identities');
  });
});

/** An oracle result whose first validity gate holds two ordered references with every member. */
function gateWithTwoReferences(): JsonObject {
  return edited(
    oracleResult(),
    ['validity_gates', 0, 'evidence_refs'],
    [
      {
        artifact_path: 'journal/events.jsonl',
        artifact_sha256: 'b'.repeat(64),
        event_id: '00000000-0000-4000-8000-000000000001',
        json_pointer: '/0',
        package_index_sha256: 'd'.repeat(64),
      },
      {
        artifact_path: 'ledger/ledger-snapshot.json',
        artifact_sha256: 'c'.repeat(64),
        event_id: '00000000-0000-4000-8000-000000000002',
        json_pointer: '/entries/0',
        package_index_sha256: 'e'.repeat(64),
      },
    ],
  );
}

const REFS = ['validity_gates', 0, 'evidence_refs'] as const;
const REFS_AT = '/validity_gates/0/evidence_refs';

// Owner amendment A-02 (WP-03 seeds -435396834 path "971:1" and 20261005 path "1223:1"): the
// `x-rua-evidence-ref-order` keyword compared unvalidated members with `<` and threw on
// {"toString":1,"valueOf":1}; Ajv's built-in uniqueItems threw the same way. Moved here from an
// unowned file in WP-00 review round 1.
describe('AC-RUA-048 a hostile evidence reference member is a type rejection, never a crash', () => {
  it('every ordering member of either reference, holding the hostile object', () => {
    for (const member of REFERENCE_MEMBERS) {
      for (const index of [0, 1]) {
        const record = edited(gateWithTwoReferences(), [...REFS, index, member], hostile());
        assert.deepEqual(violationsOf(record), [`${REFS_AT}/${String(index)}/${member} type`], member);
      }
    }
  });

  it('a null-prototype object, an array or a number as a member is a type rejection', () => {
    const nullPrototype = Object.create(null) as JsonObject;
    const cases: readonly [number, string, JsonValue][] = [
      [1, 'artifact_path', nullPrototype],
      [0, 'event_id', [HOSTILE_TEXT]],
      [0, 'json_pointer', 7],
    ];
    for (const [index, member, value] of cases) {
      const record = edited(gateWithTwoReferences(), [...REFS, index, member], value);
      assert.deepEqual(violationsOf(record), [`${REFS_AT}/${String(index)}/${member} type`], member);
    }
  });

  it('two identical hostile references are rejected per member, never a crash', () => {
    const hostileRef = (): JsonValue => ({ artifact_path: hostile(), artifact_sha256: hostile() });
    assert.deepEqual(violationsOf(edited(oracleResult(), REFS, [hostileRef(), hostileRef()])), [
      `${REFS_AT}/0/artifact_path type`,
      `${REFS_AT}/0/artifact_sha256 type`,
      `${REFS_AT}/1/artifact_path type`,
      `${REFS_AT}/1/artifact_sha256 type`,
    ]);
  });

  it('order judgment of well-typed references is unchanged', () => {
    const ordered = (gateWithTwoReferences()['validity_gates'] as JsonObject[])[0]?.['evidence_refs'] as JsonValue[];
    const reversed = edited(oracleResult(), REFS, ordered.toReversed());
    assert.deepEqual(violationsOf(reversed), [`${REFS_AT} x-rua-evidence-ref-order`]);
    const duplicated = edited(oracleResult(), REFS, [ordered[0] as JsonValue, ordered[0] as JsonValue]);
    assert.deepEqual(violationsOf(duplicated), [`${REFS_AT} x-rua-evidence-ref-order`]);
    assertAccepted(gateWithTwoReferences(), 'ordered references');
  });
});

describe('AC-RUA-046 hostile and deep causation ids are rejections, never a crash', () => {
  it('two equal hostile objects, and two null-prototype objects, are typed and duplicate findings', () => {
    for (const [first, second] of [
      [hostile(), hostile()],
      [Object.create(null) as JsonObject, Object.create(null) as JsonObject],
    ] as const) {
      const found = violationsOf({ ...dispatchStarted(), causation_event_ids: [first, second] });
      for (const expected of [
        '/causation_event_ids/0 type',
        '/causation_event_ids/1 type',
        '/causation_event_ids uniqueItems',
      ]) {
        assert.ok(found.includes(expected), `${expected} in ${JSON.stringify(found)}`);
      }
    }
  });

  it('distinct hostile objects are type rejections without a duplicate finding', () => {
    const found = violationsOf({ ...dispatchStarted(), causation_event_ids: [hostile(), { valueOf: 2 }] });
    assert.ok(found.includes('/causation_event_ids/0 type'), JSON.stringify(found));
    assert.ok(found.includes('/causation_event_ids/1 type'), JSON.stringify(found));
    assert.equal(found.includes('/causation_event_ids uniqueItems'), false, JSON.stringify(found));
  });

  it('duplicate and unsorted well-typed causation ids keep their rejections', () => {
    const duplicate = violationsOf({ ...dispatchStarted(), causation_event_ids: [LOWER_V4, LOWER_V4] });
    assert.equal(duplicate.filter((found) => found === '/causation_event_ids uniqueItems').length, 1);
    assert.ok(duplicate.includes('/causation_event_ids x-rua-ascending-unique'), JSON.stringify(duplicate));
    const later = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    // A failing envelope (`allOf`) also leaves the event's own members unevaluated, so only the
    // array's findings are pinned here.
    const unsorted = violationsOf({ ...dispatchStarted(), causation_event_ids: [later, LOWER_V4] });
    assert.deepEqual(
      unsorted.filter((found) => found.startsWith('/causation_event_ids')),
      ['/causation_event_ids x-rua-ascending-unique'],
    );
  });

  it(`a ${String(DEEP_NESTING)}-level value anywhere in a record is a finding, never a RangeError`, () => {
    const deepArray = parsedTower('array');
    const twin = parsedTower('array');
    const causes = violationsOf({ ...dispatchStarted(), causation_event_ids: [deepArray, twin] });
    assert.ok(causes.includes('/causation_event_ids uniqueItems'), JSON.stringify(causes));
    assert.deepEqual(violationsOf(edited(oracleResult(), [...REFS, 0], deepArray)), [`${REFS_AT}/0 type`]);
    assert.deepEqual(violationsOf({ ...payment(), record_type: deepArray }), ['/record_type record_type']);
    assert.deepEqual(violationsOf(deepArray), [' type']);
  });
});
