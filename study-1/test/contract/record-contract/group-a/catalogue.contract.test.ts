// AC-RUA-046 (group A): every group A record type has its three catalogue parts (design §6): a
// JSON Schema that follows the catalogue conventions, a TypeScript interface module whose closed
// vocabularies equal the schema enums, and a canonical valid example that survives the BR-RUA-033 canonical serialization round trip.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { serializeRecordFile, structurallyEqual } from '../../../../src/record-contract/canonical-json.ts';
import { isJsonArray, isJsonObject } from '../../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import { findSchemaConventionViolations } from '../../../../src/record-contract/schema-conventions.ts';
import {
  ADMISSION_CHECK_IDS,
  ADMISSION_REJECTION_CLASSES,
} from '../../../../src/record-contract/records/group-a/admission_rejection.ts';
import {
  CA_1_SCOPE,
  CA_1_STATEMENT,
  RUN_TRIAL_ORDER,
  VALIDATION_SCENARIO_ORDER,
} from '../../../../src/record-contract/records/group-a/execution_manifest.ts';
import { PREFLIGHT_CHECK_RESULTS } from '../../../../src/record-contract/records/group-a/preflight_check_recorded.ts';
import { PROVIDER_CALLER_IDS } from '../../../../src/record-contract/records/group-a/provider_refund_call.ts';
import {
  PROVIDER_REFUND_OUTCOMES,
  PROVIDER_REJECTION_REASONS,
} from '../../../../src/record-contract/records/group-a/provider_refund_response.ts';
import {
  OWNERSHIP_TAG_KEYS,
  PROVISIONING_STATUSES,
} from '../../../../src/record-contract/records/group-a/resource_manifest.ts';
import * as groupBVocabulary from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import type { StudyRecord } from '../../../../src/record-contract/records/index.ts';
import { DEFAULT_SCHEMA_ROOT, listSchemaFiles } from '../../../../src/record-contract/schema-registry.ts';
import { admissionRejection } from './support/admission-examples.ts';
import { CANONICAL_EXAMPLES, allValidExamples } from './support/canonical-examples.ts';
import { assertAccepted, catalogueValidator, violationsOf, withField } from './support/validation-assertions.ts';

const GROUP_A = RECORD_TYPE_GROUPS['group-a'];

// The runtime (non-type) exports of each interface module; a module absent here exports types only.
const RUNTIME_EXPORTS: Partial<Readonly<Record<(typeof GROUP_A)[number], readonly string[]>>> = {
  admission_rejection: ['ADMISSION_CHECK_IDS', 'ADMISSION_REJECTION_CLASSES'],
  execution_manifest: ['CA_1_SCOPE', 'CA_1_STATEMENT', 'RUN_TRIAL_ORDER', 'VALIDATION_SCENARIO_ORDER'],
  preflight_check_recorded: ['PREFLIGHT_CHECK_RESULTS'],
  provider_refund_call: ['PROVIDER_CALLER_IDS'],
  provider_refund_response: ['PROVIDER_REFUND_OUTCOMES', 'PROVIDER_REJECTION_REASONS'],
  resource_manifest: ['OWNERSHIP_TAG_KEYS', 'PROVISIONING_STATUSES'],
};

// Each closed vocabulary and every schema location that must enforce exactly it.
const VOCABULARY_SITES: readonly (readonly [readonly string[], (typeof GROUP_A)[number], string])[] = [
  [ADMISSION_REJECTION_CLASSES, 'admission_rejection', '/properties/rejection_class/enum'],
  [ADMISSION_REJECTION_CLASSES, 'preflight_check_recorded', '/properties/rejection_class/enum'],
  [ADMISSION_REJECTION_CLASSES, 'preflight_check_recorded', '/then/properties/rejection_class/enum'],
  [PREFLIGHT_CHECK_RESULTS, 'preflight_check_recorded', '/properties/result/enum'],
  [PROVIDER_CALLER_IDS, 'provider_refund_call', '/properties/caller_id/enum'],
  [PROVIDER_CALLER_IDS, 'provider_trial_configuration', '/properties/registered_caller_id/enum'],
  [PROVIDER_REFUND_OUTCOMES, 'provider_refund_response', '/properties/outcome/enum'],
  [PROVIDER_REJECTION_REASONS, 'provider_refund_response', '/properties/rejection_reason/enum'],
  [PROVIDER_REJECTION_REASONS, 'provider_refund_response', '/else/properties/rejection_reason/enum'],
  [PROVISIONING_STATUSES, 'resource_manifest', '/properties/provisioning_status/enum'],
  [OWNERSHIP_TAG_KEYS, 'resource_manifest', '/properties/ownership_tags/items/properties/key/enum'],
];

function schemaOf(type: (typeof GROUP_A)[number]): JsonValue {
  const parsed = parseJsonDocument(readFileSync(join(DEFAULT_SCHEMA_ROOT, 'group-a', `${type}.schema.json`)));
  assert.ok(parsed.ok, `${type}: the schema file is a JSON document`);
  return parsed.value;
}

function resolvePointer(root: JsonValue, pointer: string): JsonValue | undefined {
  return pointer
    .split('/')
    .slice(1)
    .reduce<JsonValue | undefined>((node, segment) => {
      if (isJsonArray(node)) {
        return node[Number(segment)];
      }
      return isJsonObject(node) ? node[segment] : undefined;
    }, root);
}

describe('AC-RUA-046 group A catalogue', () => {
  it('lists exactly one schema file per group A record type', () => {
    const groupA = listSchemaFiles().filter((file) => file.relative_path.startsWith('group-a/'));
    assert.deepEqual(
      groupA.map((file) => file.relative_path),
      GROUP_A.map((type) => `group-a/${type}.schema.json`).toSorted(),
    );
    assert.equal(GROUP_A.length, 18);
  });

  it('every group A schema follows the catalogue conventions', () => {
    for (const type of GROUP_A) {
      assert.deepEqual(findSchemaConventionViolations(type, schemaOf(type)), [], type);
    }
  });

  it('every group A interface module loads and exports exactly its runtime vocabulary', async () => {
    for (const type of GROUP_A) {
      const module = (await import(`../../../../src/record-contract/records/group-a/${type}.ts`)) as Readonly<
        Record<string, unknown>
      >;
      assert.deepEqual(Object.keys(module).toSorted(), RUNTIME_EXPORTS[type] ?? [], `${type}: runtime exports`);
    }
  });

  it('exports closed vocabularies equal to the schema enums they mirror', () => {
    for (const [values, type, pointer] of VOCABULARY_SITES) {
      assert.deepEqual(resolvePointer(schemaOf(type), pointer), [...values], `${type}${pointer}`);
    }
    // The probe-or-trial split of the registered caller partitions the same caller vocabulary.
    const configuration = schemaOf('provider_trial_configuration');
    assert.deepEqual(
      [
        ...((resolvePointer(configuration, '/else/properties/registered_caller_id/enum') ?? []) as string[]),
        resolvePointer(configuration, '/then/properties/registered_caller_id/const'),
      ],
      [...PROVIDER_CALLER_IDS],
    );
    // One provider rejection vocabulary: the group B event copy must not drift from the wire.
    assert.deepEqual(groupBVocabulary.PROVIDER_REJECTION_REASONS, PROVIDER_REJECTION_REASONS);
    for (const id of ADMISSION_CHECK_IDS) {
      assertAccepted(withField(admissionRejection(), 'failed_check_id', id), `check ${id}`);
    }
    assert.deepEqual(
      ADMISSION_CHECK_IDS,
      Array.from({ length: 15 }, (_, index) => `A${String(index + 1)}`),
    );
    const execution = schemaOf('execution_manifest');
    assert.equal(resolvePointer(execution, '/$defs/clock_assumption_ca_1/properties/scope/const'), CA_1_SCOPE);
    assert.equal(resolvePointer(execution, '/$defs/clock_assumption_ca_1/properties/statement/const'), CA_1_STATEMENT);
  });

  it('declares the BR-RUA-019 and BR-RUA-038 trial orders identically in both manifests', () => {
    for (const type of ['execution_manifest', 'trial_manifest'] as const) {
      const schema = schemaOf(type);
      RUN_TRIAL_ORDER.forEach((trial, index) => {
        const entry = `/$defs/run_trial_${String(index + 1)}/properties`;
        assert.deepEqual(
          {
            sequence: resolvePointer(schema, `${entry}/sequence/const`),
            variant_id: resolvePointer(schema, `${entry}/variant_id/const`),
            scenario: resolvePointer(schema, `${entry}/scenario/const`),
          },
          trial,
          `${type} run position ${String(index + 1)}`,
        );
      });
      VALIDATION_SCENARIO_ORDER.forEach((scenario, index) => {
        const entry = `/$defs/validation_trial_${String(index + 1)}/properties`;
        assert.equal(resolvePointer(schema, `${entry}/scenario/const`), scenario, `${type} validation scenario`);
        assert.equal(resolvePointer(schema, `${entry}/sequence/const`), index + 1, `${type} validation sequence`);
      });
    }
  });

  it('has one canonical example per record type that validates as its own type', () => {
    assert.deepEqual(Object.keys(CANONICAL_EXAMPLES).toSorted(), [...GROUP_A].toSorted());
    for (const type of GROUP_A) {
      const example = CANONICAL_EXAMPLES[type]();
      assert.equal(example['record_type'], type);
      assertAccepted(example, `canonical ${type}`);
    }
  });

  it('every valid example survives the canonical serialization round trip unchanged', () => {
    for (const { name, record } of allValidExamples()) {
      const bytes = serializeRecordFile(record as unknown as StudyRecord);
      assert.equal(bytes.at(-1), 0x0a, `${name}: a record file ends with one newline`);
      const reparsed = parseJsonDocument(bytes);
      assert.ok(reparsed.ok, `${name}: the serialized bytes parse back`);
      assert.ok(structurallyEqual(reparsed.value, record), `${name}: structurally equal after the round trip`);
      assert.deepEqual(violationsOf(catalogueValidator.validate(reparsed.value)), [], `${name}: still valid`);
    }
  });

  it('refuses an example declared as another group A record type', () => {
    assert.deepEqual(violationsOf(catalogueValidator.validateAs('approved_decision', CANONICAL_EXAMPLES.payment())), [
      '/record_type const',
    ]);
  });
});
