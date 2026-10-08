// AC-RUA-046 / AC-RUA-048 fuzz (Owner amendment A-02): record validation is total. Arbitrary
// JSON, plus hostile objects such as `{"toString":1,"valueOf":1}` and null-prototype objects, is
// substituted at every reference member of the shared `$defs` (evidence references and causation
// ids). `createRecordValidator().validate` and the code-level evidence-reference check must
// return findings and never throw; a non-string ordering member must be a type finding at that
// member and never an order finding. A second target checks the kernel's `uniqueItems` against
// two oracles: canonical JSON equality (BR-RUA-034) and an independent pairwise scan with
// structural equality. Since WP-00 review round 1, about 2% of drawn values are towers nested
// 2,500-20,000 levels deep, past the call stack, where the recursive kernel code threw RangeError.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { validateEvidenceRefList } from '../../../src/record-contract/evidence-refs.ts';
import type { ReferenceLocation } from '../../../src/record-contract/evidence-refs.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { RecordValidation } from '../../../src/record-contract/schema-registry.ts';
import {
  EVIDENCE_REF_ORDER_KEYWORD,
  registerRecordVocabulary,
} from '../../../src/record-contract/schema-vocabulary.ts';
import { sameJsonValue } from '../../../src/record-contract/json-value.ts';
import { deepTowerArbitrary } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  FIXTURE_CATALOGUE_ROOT,
  SAMPLE_UUIDS,
  SHARED_DEFS_PATH,
  sampleDispatchStarted,
  sampleOracleResult,
} from '../../support/kernel/schema-fixtures.ts';

const validator = createRecordValidator({ schemaRoot: FIXTURE_CATALOGUE_ROOT, defsPath: SHARED_DEFS_PATH });
const REFERENCE_MEMBERS = [
  'artifact_path',
  'artifact_sha256',
  'event_id',
  'json_pointer',
  'package_index_sha256',
] as const;
const HOSTILE_TEXTS = [
  '{"toString":1,"valueOf":1}',
  '{"valueOf":1,"toString":1}',
  '{"__proto__":{"toString":1}}',
  '{"constructor":{"name":1},"toJSON":1,"hasOwnProperty":1}',
  '[{"toString":1,"valueOf":1}]',
] as const;

/** Fresh hostile objects on every draw, so equal values are never the same reference. */
const hostileObject = fc.oneof(
  fc.constantFrom(...HOSTILE_TEXTS).map((text) => JSON.parse(text) as JsonValue),
  fc.constant(null).map(() => Object.create(null) as JsonValue),
  fc.dictionary(
    fc.constantFrom('toString', 'valueOf', 'constructor', '__proto__', 'toJSON', 'hasOwnProperty', 'artifact_path'),
    fc.jsonValue({ maxDepth: 1 }) as fc.Arbitrary<JsonValue>,
    { minKeys: 1 },
  ) as fc.Arbitrary<JsonValue>,
);
const anyJson: fc.Arbitrary<JsonValue> = fc.oneof(
  { arbitrary: fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<JsonValue>, weight: 49 },
  { arbitrary: hostileObject, weight: 49 },
  { arbitrary: deepTowerArbitrary(), weight: 2 },
);

/** Ajv's own scan order (largest i, then largest j < i), written independently of the kernel. */
function pairwiseDuplicate(items: readonly JsonValue[]): { readonly i: number; readonly j: number } | undefined {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = items.slice(0, i).findLastIndex((other) => sameJsonValue(items[i], other));
    if (j !== -1) {
      return { i, j };
    }
  }
  return undefined;
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

interface SubstitutionSite {
  readonly label: string;
  readonly place: (value: JsonValue) => JsonObject;
  /** For a single ordering member: the instance path whose type rule must report a non-string. */
  readonly memberPath?: string;
}

function refsWith(edit: (ref: JsonObject, index: number) => JsonValue): JsonObject {
  const record = twoFullReferences();
  const refs = record['evidence_refs'] as readonly JsonObject[];
  return { ...record, evidence_refs: refs.map(edit) };
}

const SITES: readonly SubstitutionSite[] = [
  ...REFERENCE_MEMBERS.flatMap((member) =>
    [0, 1].map((target) => ({
      label: `evidence_refs[${String(target)}].${member}`,
      memberPath: `/evidence_refs/${String(target)}/${member}`,
      place: (value: JsonValue): JsonObject =>
        refsWith((ref, index) => (index === target ? { ...ref, [member]: value } : ref)),
    })),
  ),
  ...REFERENCE_MEMBERS.map((member) => ({
    label: `evidence_refs[*].${member}`,
    place: (value: JsonValue): JsonObject => refsWith((ref) => ({ ...ref, [member]: value })),
  })),
  ...[0, 1].map((target) => ({
    label: `evidence_refs[${String(target)}]`,
    place: (value: JsonValue): JsonObject => refsWith((ref, index) => (index === target ? value : ref)),
  })),
  {
    label: 'evidence_refs',
    place: (value: JsonValue): JsonObject => ({ ...twoFullReferences(), evidence_refs: value }),
  },
  ...[0, 1].map((target) => ({
    label: `causation_event_ids[${String(target)}]`,
    place: (value: JsonValue): JsonObject => ({
      ...sampleDispatchStarted(),
      causation_event_ids: [SAMPLE_UUIDS.causeA, SAMPLE_UUIDS.causeB].map((id, index) =>
        index === target ? value : id,
      ),
    }),
  })),
  {
    label: 'causation_event_ids[*]',
    place: (value: JsonValue): JsonObject => ({ ...sampleDispatchStarted(), causation_event_ids: [value, value] }),
  },
  {
    label: 'causation_event_ids',
    place: (value: JsonValue): JsonObject => ({ ...sampleDispatchStarted(), causation_event_ids: value }),
  },
];

function validateTotally(record: JsonValue, label: string): RecordValidation {
  try {
    return validator.validate(record);
  } catch (error) {
    return assert.fail(`${label}: validate threw ${String(error)}; expected findings`);
  }
}

function checkReferencesTotally(record: JsonValue, location: ReferenceLocation, label: string): void {
  try {
    for (const finding of validateEvidenceRefList(record, 'evidence_refs', location)) {
      assert.ok(finding.detail.length > 0, label);
    }
  } catch (error) {
    assert.fail(`${label}: validateEvidenceRefList threw ${String(error)}; expected findings`);
  }
}

describe('AC-RUA-046 record validation is total over hostile reference members', () => {
  it('never throws, and reports a non-string ordering member by its type rule, not by order', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SITES),
        anyJson,
        fc.constantFrom<ReferenceLocation>('inside_package', 'outside_package'),
        (site, value, location) => {
          const record = site.place(value);
          const result = validateTotally(record, site.label);
          checkReferencesTotally(record, location, site.label);
          if (site.memberPath === undefined || typeof value === 'string') {
            return;
          }
          const found = result.valid ? [] : result.violations.map((v) => `${v.instance_path} ${v.keyword}`);
          assert.ok(found.includes(`${site.memberPath} type`), `${site.label}: ${JSON.stringify(found)}`);
          assert.ok(!found.includes(`/evidence_refs ${EVIDENCE_REF_ORDER_KEYWORD}`), site.label);
        },
      ),
      fuzzParameters(),
    );
  });
});

describe('AC-RUA-046 kernel uniqueItems agrees with canonical JSON equality', () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  registerRecordVocabulary(ajv);
  const unique = ajv.compile({ type: 'array', uniqueItems: true });
  const pooled = fc
    .constantFrom(...HOSTILE_TEXTS, '{}', '[]', '{"x":1}', '{"__proto__":{}}', '1', '"1"', 'null')
    .map((text) => JSON.parse(text) as JsonValue);

  it('never throws and finds a duplicate exactly when two items serialize alike', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(anyJson, pooled), { maxLength: 6 }), (items) => {
        const forms = items.map((item) => canonicalJson(item));
        const hasDuplicate = new Set(forms).size !== forms.length;
        let accepted: boolean;
        try {
          accepted = unique(items);
        } catch (error) {
          return assert.fail(`uniqueItems threw ${String(error)}; expected a verdict`);
        }
        assert.equal(accepted, !hasDuplicate, `${String(forms.length)} items`);
        const params = accepted
          ? undefined
          : (unique.errors?.[0]?.params as { readonly i: number; readonly j: number });
        assert.deepEqual(params, pairwiseDuplicate(items));
        if (params !== undefined) {
          assert.equal(forms[params.j], forms[params.i]);
        }
      }),
      fuzzParameters(),
    );
  });
});
