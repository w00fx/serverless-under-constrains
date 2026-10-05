// AC-RUA-046 / AC-RUA-048 kernel regression (Owner amendment A-02): a record parsed from
// untrusted bytes is a rejection, never a crash. WP-03's single-field mutation property
// (FC_SEED -435396834 path "971:1"; FC_SEED 20261005 FC_RUNS 10000 path "1223:1") found that
// `validate` threw `TypeError: Cannot convert object to primitive value` when an evidence
// reference member held `{"toString":1,"valueOf":1}`: the `x-rua-evidence-ref-order` keyword
// compared unvalidated members with `<`. The audit that followed found the same class of
// defect in Ajv's built-in `uniqueItems` (fast-deep-equal calls an item's own `valueOf`), which
// the shared `causation_ids` definition and many catalogue arrays use. Both are proven here at
// the kernel boundary: the real shared `$defs`, the CAP-RUA Ajv vocabulary and the fixture
// catalogue loaded from disk, every hostile document parsed from bytes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../src/record-contract/schema-registry.ts';
import {
  FIXTURE_CATALOGUE_ROOT,
  SAMPLE_UUIDS,
  SHARED_DEFS_PATH,
  sampleDispatchStarted,
  sampleOracleResult,
} from '../../support/kernel/schema-fixtures.ts';

/** The minimized counterexample WP-03 promoted: valid JSON with no primitive conversion. */
const HOSTILE_MEMBER = '{"toString":1,"valueOf":1}';
const PLACEHOLDER = '"__HOSTILE__"';
const REFERENCE_MEMBERS = [
  'artifact_path',
  'artifact_sha256',
  'event_id',
  'json_pointer',
  'package_index_sha256',
] as const;

const validator = createRecordValidator({ schemaRoot: FIXTURE_CATALOGUE_ROOT, defsPath: SHARED_DEFS_PATH });

/** Parses `record` from bytes after replacing every placeholder string with `replacement`. */
function parsedWith(record: JsonObject, replacement: string): JsonValue {
  const text = JSON.stringify(record).replaceAll(PLACEHOLDER, replacement);
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  assert.ok(parsed.ok, `the hostile document parses as JSON: ${text}`);
  return parsed.value;
}

function validateWithoutThrowing(value: JsonValue): RecordValidation {
  try {
    return validator.validate(value);
  } catch (error) {
    return assert.fail(`validate threw ${String(error)}; expected a rejection`);
  }
}

function violationsOf(result: RecordValidation): readonly string[] {
  return result.valid ? [] : result.violations.map((violation) => `${violation.instance_path} ${violation.keyword}`);
}

/** An oracle result with two canonically ordered references, each carrying every member. */
function twoFullReferences(): JsonObject {
  return {
    ...sampleOracleResult(),
    evidence_refs: [
      {
        artifact_path: 'journal/events.jsonl',
        artifact_sha256: 'b'.repeat(64),
        event_id: SAMPLE_UUIDS.event,
        json_pointer: '/0',
        package_index_sha256: 'd'.repeat(64),
      },
      {
        artifact_path: 'ledger/ledger-snapshot.json',
        artifact_sha256: 'c'.repeat(64),
        event_id: SAMPLE_UUIDS.run,
        json_pointer: '/entries/0',
        package_index_sha256: 'e'.repeat(64),
      },
    ],
  };
}

function withMember(record: JsonObject, index: number, member: string, value: JsonValue): JsonObject {
  const refs = record['evidence_refs'] as readonly JsonObject[];
  return {
    ...record,
    evidence_refs: refs.map((ref, at) => (at === index ? { ...ref, [member]: value } : ref)),
  };
}

describe('AC-RUA-048 a hostile evidence reference member is a type rejection, never a crash', () => {
  it('the minimized counterexample: artifact_path {"toString":1,"valueOf":1} in the shared evidence_refs', () => {
    const record = withMember(sampleOracleResult(), 0, 'artifact_path', '__HOSTILE__');
    const result = validateWithoutThrowing(parsedWith(record, HOSTILE_MEMBER));
    assert.deepEqual(violationsOf(result), ['/evidence_refs/0/artifact_path type']);
  });

  it('every ordering member of either reference, holding the hostile object', () => {
    for (const member of REFERENCE_MEMBERS) {
      for (const index of [0, 1]) {
        const record = withMember(twoFullReferences(), index, member, '__HOSTILE__');
        const result = validateWithoutThrowing(parsedWith(record, HOSTILE_MEMBER));
        assert.deepEqual(violationsOf(result), [`/evidence_refs/${String(index)}/${member} type`], member);
      }
    }
  });

  it('a null-prototype object and an array as a member are type rejections, not order rejections', () => {
    const nullPrototype = withMember(twoFullReferences(), 1, 'artifact_path', Object.create(null) as JsonObject);
    assert.deepEqual(violationsOf(validateWithoutThrowing(nullPrototype)), ['/evidence_refs/1/artifact_path type']);
    const array = withMember(twoFullReferences(), 0, 'event_id', [HOSTILE_MEMBER]);
    assert.deepEqual(violationsOf(validateWithoutThrowing(array)), ['/evidence_refs/0/event_id type']);
    const number = withMember(twoFullReferences(), 0, 'json_pointer', 7);
    assert.deepEqual(violationsOf(validateWithoutThrowing(number)), ['/evidence_refs/0/json_pointer type']);
  });

  it('two identical hostile references are rejected per member and as duplicates, never a crash', () => {
    const hostileRef: JsonObject = { artifact_path: '__HOSTILE__', artifact_sha256: '__HOSTILE__' };
    const record = { ...sampleOracleResult(), evidence_refs: [hostileRef, hostileRef] };
    const violations = violationsOf(validateWithoutThrowing(parsedWith(record, HOSTILE_MEMBER)));
    assert.deepEqual(violations, [
      '/evidence_refs/0/artifact_path type',
      '/evidence_refs/0/artifact_sha256 type',
      '/evidence_refs/1/artifact_path type',
      '/evidence_refs/1/artifact_sha256 type',
    ]);
  });

  it('order judgment of well-typed references is unchanged', () => {
    const ordered = twoFullReferences()['evidence_refs'] as readonly JsonValue[];
    const reversed = { ...twoFullReferences(), evidence_refs: ordered.toReversed() };
    assert.deepEqual(violationsOf(validateWithoutThrowing(reversed)), ['/evidence_refs x-rua-evidence-ref-order']);
    const [first] = ordered;
    assert.ok(first !== undefined);
    const duplicated = { ...sampleOracleResult(), evidence_refs: [first, first] };
    assert.deepEqual(violationsOf(validateWithoutThrowing(duplicated)), ['/evidence_refs x-rua-evidence-ref-order']);
    assert.deepEqual(violationsOf(validateWithoutThrowing(twoFullReferences())), []);
  });
});

describe('AC-RUA-046 hostile causation ids are rejections, never a crash (uniqueItems audit)', () => {
  it('two equal hostile objects in causation_event_ids', () => {
    const record = { ...sampleDispatchStarted(), causation_event_ids: ['__HOSTILE__', '__HOSTILE__'] };
    const violations = violationsOf(validateWithoutThrowing(parsedWith(record, HOSTILE_MEMBER)));
    assert.ok(violations.includes('/causation_event_ids/0 type'), JSON.stringify(violations));
    assert.ok(violations.includes('/causation_event_ids/1 type'), JSON.stringify(violations));
    assert.ok(violations.includes('/causation_event_ids uniqueItems'), JSON.stringify(violations));
  });

  it('two null-prototype objects in causation_event_ids', () => {
    const record = {
      ...sampleDispatchStarted(),
      causation_event_ids: [Object.create(null) as JsonObject, Object.create(null) as JsonObject],
    };
    const violations = violationsOf(validateWithoutThrowing(record));
    assert.ok(violations.includes('/causation_event_ids/0 type'), JSON.stringify(violations));
    assert.ok(violations.includes('/causation_event_ids uniqueItems'), JSON.stringify(violations));
  });

  it('distinct hostile objects are type rejections without a duplicate finding', () => {
    const record = { ...sampleDispatchStarted(), causation_event_ids: ['__HOSTILE__', { valueOf: 2 }] };
    const violations = violationsOf(validateWithoutThrowing(parsedWith(record, HOSTILE_MEMBER)));
    assert.ok(violations.includes('/causation_event_ids/0 type'), JSON.stringify(violations));
    assert.ok(violations.includes('/causation_event_ids/1 type'), JSON.stringify(violations));
    assert.equal(violations.includes('/causation_event_ids uniqueItems'), false, JSON.stringify(violations));
  });

  it('duplicate and unsorted well-typed causation ids keep their rejections', () => {
    const duplicate = { ...sampleDispatchStarted(), causation_event_ids: [SAMPLE_UUIDS.causeA, SAMPLE_UUIDS.causeA] };
    const duplicateViolations = violationsOf(validateWithoutThrowing(duplicate));
    assert.equal(
      duplicateViolations.filter((violation) => violation === '/causation_event_ids uniqueItems').length,
      1,
      JSON.stringify(duplicateViolations),
    );
    assert.ok(
      duplicateViolations.includes('/causation_event_ids x-rua-ascending-unique'),
      JSON.stringify(duplicateViolations),
    );
    // A failing envelope (`allOf`) also leaves its members unevaluated, so only the array's own
    // findings are pinned here.
    const unsorted = { ...sampleDispatchStarted(), causation_event_ids: [SAMPLE_UUIDS.causeB, SAMPLE_UUIDS.causeA] };
    const unsortedViolations = violationsOf(validateWithoutThrowing(unsorted)).filter((violation) =>
      violation.startsWith('/causation_event_ids'),
    );
    assert.deepEqual(unsortedViolations, ['/causation_event_ids x-rua-ascending-unique']);
  });
});
