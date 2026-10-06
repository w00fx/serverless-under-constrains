// Regression for a single-field-mutation counterexample (FC seed -435396834, path "971:1"):
// an ordered reference list whose string member holds an object without a primitive value
// (`{"toString":1,"valueOf":1}` is valid JSON) made the `x-rua-evidence-ref-order` keyword
// throw `TypeError: Cannot convert object to primitive value` out of `validate`, instead of
// rejecting the record. Untrusted package bytes reach the validator (BR-RUA-043 ingestion), so
// a hostile member must be a rejection at that member. The fix belongs to the WP-00 kernel
// (`compareEvidenceRefs` in src/record-contract/evidence-refs.ts, called by
// `isCanonicalRefOrder` in src/record-contract/schema-vocabulary.ts).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ProbeUsabilityAssessment } from '../../../../src/record-contract/records/group-c/probe_usability_assessment.ts';
import type { RecordValidation } from '../../../../src/record-contract/schema-registry.ts';
import { groupBValidator } from '../../../support/record-contract/group-b-validation.ts';
import { toJson } from '../../../support/record-contract/record-builders.ts';
import { runPackageIndex } from './examples/package-examples.ts';
import { usableProbe } from './examples/probe-examples.ts';
import { EXECUTION_MANIFEST_PATH, evidenceRef } from './support/group-c-builders.ts';

const HOSTILE_MEMBER = '{"toString":1,"valueOf":1}';

interface HostileCase {
  readonly label: string;
  readonly record: JsonObject;
  /** The reference list, and the first item's path, which occurs once in the record. */
  readonly list: string;
  readonly firstPath: string;
}

const PROBE_RESULT = 'probe/derived/transport-probe-result.json';

function probeWithTwoReferences(): ProbeUsabilityAssessment {
  return { ...usableProbe(), evidence_refs: [evidenceRef(PROBE_RESULT), evidenceRef('probe/z.json')] };
}

const CASES: readonly HostileCase[] = [
  {
    label: 'package_index entries',
    record: toJson(runPackageIndex()),
    list: 'entries',
    firstPath: EXECUTION_MANIFEST_PATH,
  },
  {
    label: 'probe_usability_assessment evidence_refs (_defs evidence_refs)',
    record: toJson(probeWithTwoReferences()),
    list: 'evidence_refs',
    firstPath: PROBE_RESULT,
  },
];

/** The record as parsed from bytes in which the first reference path is the hostile object. */
function hostileDocument(hostile: HostileCase): JsonValue {
  const text = JSON.stringify(hostile.record).replace(JSON.stringify(hostile.firstPath), HOSTILE_MEMBER);
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  assert.ok(parsed.ok, `${hostile.label}: the hostile document parses as JSON`);
  return parsed.value;
}

function validateWithoutThrowing(value: JsonValue): RecordValidation | Error {
  try {
    return groupBValidator.validate(value);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

describe('AC-RUA-046 a hostile reference member is a rejection, never a crash', () => {
  for (const hostile of CASES) {
    it(hostile.label, () => {
      const outcome = validateWithoutThrowing(hostileDocument(hostile));
      if (outcome instanceof Error) {
        assert.fail(`${hostile.label}: validate threw ${outcome.name}: ${outcome.message}`);
      }
      const violations = outcome.valid ? [] : outcome.violations;
      assert.ok(
        violations.some(
          (violation) => violation.instance_path === `/${hostile.list}/0/artifact_path` && violation.keyword === 'type',
        ),
        `${hostile.label}: expected a type violation at the hostile member, got ${JSON.stringify(violations)}`,
      );
    });
  }
});
