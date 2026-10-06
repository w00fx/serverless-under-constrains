// Regression (WP-00 review round 1, Owner amendment A-02 "the validator never throws on any
// JSON value"): every kernel function that takes parsed JSON is total over nesting deeper than
// the call stack. The former recursive code threw RangeError near 2,500 levels (about 10 KB):
// sameJsonValue behind the kernel's uniqueItems, JSON.stringify in describeJson and in the
// registry's details, and canonicalJson / structurallyEqual. Each case parses a 50,000-level
// tower from bytes, as ingestion would, and places it where the probes crashed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson, structurallyEqual } from '../../../src/record-contract/canonical-json.ts';
import { validateEvidenceRefList } from '../../../src/record-contract/evidence-refs.ts';
import {
  QUOTED_JSON_LIMIT,
  boundedJsonText,
  describeJson,
  findDuplicateItems,
  sameJsonValue,
} from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../src/record-contract/schema-registry.ts';
import { DEEP_NESTING, parsedJson, parsedTower, towerText } from '../../support/kernel/deep-json.ts';
import {
  FIXTURE_CATALOGUE_ROOT,
  SHARED_DEFS_PATH,
  sampleDispatchStarted,
  sampleOracleResult,
} from '../../support/kernel/schema-fixtures.ts';

const validator = createRecordValidator({ schemaRoot: FIXTURE_CATALOGUE_ROOT, defsPath: SHARED_DEFS_PATH });
const deepArray = parsedTower('array');
const deepObject = parsedTower('object');
const TRUNCATED = '…[truncated]';

function violationsOf(result: RecordValidation): readonly string[] {
  return result.valid ? [] : result.violations.map((violation) => `${violation.instance_path} ${violation.keyword}`);
}

describe('canonical serialization over deep JSON', () => {
  it('writes a deep array and a deep object without a RangeError', () => {
    assert.equal(canonicalJson(deepArray), towerText('array', DEEP_NESTING, '1'));
    assert.equal(canonicalJson(deepObject), towerText('object', DEEP_NESTING, '1'));
  });

  it('compares deep values structurally', () => {
    const twin = parsedTower('array');
    const other = parsedJson(towerText('array', DEEP_NESTING, '2'));
    assert.equal(structurallyEqual(deepArray, twin), true);
    assert.equal(structurallyEqual(deepArray, other), false);
    assert.equal(structurallyEqual(deepArray, deepObject), false);
  });
});

describe('structural equality and duplicates over deep JSON', () => {
  it('sameJsonValue compares deep values without a RangeError', () => {
    assert.equal(sameJsonValue(deepArray, parsedTower('array')), true);
    assert.equal(sameJsonValue(deepObject, parsedTower('object')), true);
    assert.equal(sameJsonValue(deepArray, parsedJson(towerText('array', DEEP_NESTING, '2'))), false);
    assert.equal(sameJsonValue(deepArray, parsedTower('array', DEEP_NESTING - 1)), false);
  });

  it('findDuplicateItems finds equal deep items and tells different ones apart', () => {
    assert.deepEqual(findDuplicateItems([deepArray, 'x', parsedTower('array')]), { earlier: 0, later: 2 });
    assert.equal(findDuplicateItems([deepArray, parsedTower('array', DEEP_NESTING - 1)]), undefined);
  });
});

describe('bounded details over deep and huge JSON', () => {
  it('describeJson quotes at most QUOTED_JSON_LIMIT characters of a deep value', () => {
    assert.equal(describeJson(deepArray), `array ${'['.repeat(QUOTED_JSON_LIMIT)}${TRUNCATED}`);
    assert.equal(describeJson(deepObject), `object ${'{"a":'.repeat(40)}${TRUNCATED}`);
  });

  it('boundedJsonText cuts a huge string, key or array at the limit', () => {
    const huge = 'x'.repeat(1_000_000);
    assert.equal(boundedJsonText(huge), `"${'x'.repeat(QUOTED_JSON_LIMIT - 1)}${TRUNCATED}`);
    assert.equal(boundedJsonText({ [huge]: 1 }), `{"${'x'.repeat(QUOTED_JSON_LIMIT - 2)}${TRUNCATED}`);
    const many = Array.from({ length: 1_000_000 }, () => 0);
    assert.equal(boundedJsonText(many), `[${'0,'.repeat(99)}0${TRUNCATED}`);
  });
});

describe('validateEvidenceRefList over deep JSON', () => {
  const malformed = (findings: readonly { violation: string; detail: string }[]): readonly string[] =>
    findings.map((finding) => {
      assert.ok(
        finding.detail.length < 2 * QUOTED_JSON_LIMIT + 200,
        `bounded detail: ${String(finding.detail.length)}`,
      );
      return finding.violation;
    });

  it('reports a deep container, list, entry or member as MALFORMED_FIELD', () => {
    assert.deepEqual(malformed(validateEvidenceRefList(deepArray, 'evidence_refs', 'inside_package')), [
      'MALFORMED_FIELD',
    ]);
    assert.deepEqual(
      malformed(validateEvidenceRefList({ evidence_refs: deepObject }, 'evidence_refs', 'inside_package')),
      ['MALFORMED_FIELD'],
    );
    assert.deepEqual(
      malformed(validateEvidenceRefList({ evidence_refs: [deepArray] }, 'evidence_refs', 'outside_package')),
      ['MALFORMED_FIELD'],
    );
    const deepMembers: JsonObject = { artifact_path: deepArray, artifact_sha256: deepObject, event_id: deepArray };
    assert.deepEqual(
      malformed(validateEvidenceRefList({ evidence_refs: [deepMembers] }, 'evidence_refs', 'inside_package')),
      ['MALFORMED_FIELD', 'MALFORMED_FIELD', 'MALFORMED_FIELD'],
    );
  });
});

describe('record validation over deep JSON', () => {
  it('rejects a deep top-level value and a deep record_type without a RangeError', () => {
    assert.deepEqual(violationsOf(validator.validate(deepArray)), [' type']);
    const deepType: JsonObject = { ...sampleDispatchStarted(), record_type: deepObject };
    assert.deepEqual(violationsOf(validator.validate(deepType)), ['/record_type record_type']);
    assert.deepEqual(violationsOf(validator.validateAs('payment', deepType)), ['/record_type const']);
    const detail = validator.validate(deepArray);
    assert.ok(!detail.valid && (detail.violations[0]?.detail.length ?? 0) < QUOTED_JSON_LIMIT + 100);
  });

  it('judges uniqueItems over deep causation ids (the 12 KB probe document)', () => {
    const record: JsonValue = { ...sampleDispatchStarted(), causation_event_ids: [deepArray, parsedTower('array')] };
    const violations = violationsOf(validator.validate(record));
    assert.ok(violations.includes('/causation_event_ids/0 type'), JSON.stringify(violations));
    assert.ok(violations.includes('/causation_event_ids/1 type'), JSON.stringify(violations));
    assert.ok(violations.includes('/causation_event_ids uniqueItems'), JSON.stringify(violations));
  });

  it('rejects deep evidence references by their shape, never by a crash', () => {
    const arrays: JsonValue = { ...sampleOracleResult(), evidence_refs: [deepArray, parsedTower('array')] };
    assert.deepEqual(violationsOf(validator.validate(arrays)), ['/evidence_refs/0 type', '/evidence_refs/1 type']);
    // Two equal objects holding only the unknown member `a`: each misses both required members,
    // and as equal references they also break the canonical order (duplicates are rejected).
    const objects: JsonValue = { ...sampleOracleResult(), evidence_refs: [deepObject, parsedTower('object')] };
    assert.deepEqual(violationsOf(validator.validate(objects)), [
      '/evidence_refs/0 required',
      '/evidence_refs/0 required',
      '/evidence_refs/0 additionalProperties',
      '/evidence_refs/1 required',
      '/evidence_refs/1 required',
      '/evidence_refs/1 additionalProperties',
      '/evidence_refs x-rua-evidence-ref-order',
    ]);
  });
});
