// Property-based tests of the controller's control-item decoders (testing rule 6: decoders of
// state written by another source; WP-08 review r1). The decoders are total over any attribute
// values, including values nested deeper than the call stack, and on near-valid items they accept
// exactly what an independent, field-by-field restatement of design §9.3 / §9.11 accepts, with
// the decoded view equal to the item's fields.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  decodeControllerConfig,
  decodeControllerTreatment,
} from '../../../src/treatment-controller/controller-control-items.ts';
import type { ExperimentPartition } from '../../../src/treatment-controller/controller-partition.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { nestedArrays, nestedObjects } from '../../support/transport-rehearsal/deep-values.ts';
import {
  ATTEMPT_ID,
  CALLER_EVENT_ID,
  MANIFEST_SHA,
  OTHER_TRIAL_ID,
  PROBE_PK,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  committedTreatmentItem,
  probeConfigItem,
  signalledTreatmentItem,
  trialConfigItem,
} from '../../unit/treatment-controller/support/controller-fixtures.ts';

// Restated from the spec vocabularies (BR-RUA-025 treatment states, CTR-RUA-005 callers and
// scenarios) rather than imported from the decoder's module.
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const CALLERS: readonly JsonValue[] = ['conventional', 'durable', 'probe'];
const SCENARIO_NAMES: readonly JsonValue[] = ['CONTROL', 'COMMIT_THEN_TIMEOUT'];
const COMMIT_FIELDS = ['targeted_attempt_id', 'provider_commit_id', 'commit_event_id'] as const;
const SIGNALLED = ['TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED'];

const PROBE_PARTITION: ExperimentPartition = { kind: 'probe', key: PROBE_PK };
const TRIAL_PARTITION: ExperimentPartition = { kind: 'trial', key: TRIAL_PK, trial_id: TRIAL_ID };

const deepValue: fc.Arbitrary<JsonValue> = fc
  .tuple(fc.integer({ min: 7_000, max: 12_000 }), fc.boolean())
  .map(([depth, arrays]) => (arrays ? nestedArrays(depth) : nestedObjects(depth)));

const attributeValue: fc.Arbitrary<JsonValue> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom<JsonValue>(
      MANIFEST_SHA,
      MANIFEST_SHA.toUpperCase(),
      TRIAL_MANIFEST_SHA,
      TRIAL_ID,
      OTHER_TRIAL_ID,
      ATTEMPT_ID,
      CALLER_EVENT_ID,
      ATTEMPT_ID.toUpperCase(),
      'conventional',
      'durable',
      'probe',
      'runner',
      'CONTROL',
      'COMMIT_THEN_TIMEOUT',
      'control',
      'ARMED',
      'COMMITTED_WAITING',
      'TIMEOUT_SIGNALLED',
      'TIMEOUT_OBSERVED',
      'RESPONSE_RELEASED',
      'SAFETY_RELEASED',
      'RELEASED',
      0,
      1,
      2,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      '',
      null,
      true,
      [],
      {},
    ),
  },
  fc.string({ maxLength: 6 }),
  deepValue,
);

type Mutation = readonly [string, JsonValue | undefined];

function mutated(base: StoredItem, mutations: readonly Mutation[]): StoredItem {
  const item: Record<string, JsonValue> = { ...base };
  for (const [field, value] of mutations) {
    if (value === undefined) {
      Reflect.deleteProperty(item, field);
      continue;
    }
    item[field] = value;
  }
  return item as StoredItem;
}

const mutations = (fields: readonly string[]): fc.Arbitrary<readonly Mutation[]> =>
  fc.array(fc.tuple(fc.constantFrom(...fields), fc.option(attributeValue, { nil: undefined, freq: 4 })), {
    maxLength: 2,
  });

const CONFIG_FIELDS = [
  'execution_manifest_sha256',
  'registered_caller_id',
  'scenario',
  'trial_id',
  'trial_manifest_sha256',
];
const TREATMENT_FIELDS = ['state', 'version', ...COMMIT_FIELDS, 'signal_caller_event_id'];

const configCase = fc.oneof(
  fc
    .tuple(mutations(CONFIG_FIELDS), fc.constantFrom('CONTROL', 'COMMIT_THEN_TIMEOUT' as const))
    .map(([changes, scenario]) => ({
      partition: TRIAL_PARTITION,
      item: mutated(trialConfigItem(scenario), changes),
    })),
  mutations(CONFIG_FIELDS).map((changes) => ({
    partition: PROBE_PARTITION,
    item: mutated(probeConfigItem(), changes),
  })),
);

const treatmentBase = fc.constantFrom<StoredItem>(
  { pk: TRIAL_PK, sk: 'treatment', state: 'ARMED', version: 1 },
  committedTreatmentItem(TRIAL_PK),
  signalledTreatmentItem(TRIAL_PK, 'TIMEOUT_SIGNALLED'),
  signalledTreatmentItem(TRIAL_PK, 'RESPONSE_RELEASED'),
  { ...signalledTreatmentItem(TRIAL_PK, 'TIMEOUT_OBSERVED'), state: 'SAFETY_RELEASED' },
);
const treatmentItem = fc
  .tuple(treatmentBase, mutations(TREATMENT_FIELDS))
  .map(([base, changes]) => mutated(base, changes));

function matches(pattern: RegExp, value: JsonValue | undefined): value is string {
  return typeof value === 'string' && pattern.test(value);
}

function configExpected(item: StoredItem, partition: ExperimentPartition): JsonObject | undefined {
  const digest = item['execution_manifest_sha256'];
  const fieldsHold =
    matches(SHA256, digest) &&
    CALLERS.includes(item['registered_caller_id'] ?? '') &&
    SCENARIO_NAMES.includes(item['scenario'] ?? '');
  if (!fieldsHold) {
    return undefined;
  }
  const view = {
    execution_manifest_sha256: digest,
    registered_caller_id: item['registered_caller_id'] ?? null,
    scenario: item['scenario'] ?? null,
  };
  if (partition.kind === 'probe') {
    return item['trial_id'] === undefined && item['trial_manifest_sha256'] === undefined ? view : undefined;
  }
  const trialDigest = item['trial_manifest_sha256'];
  return item['trial_id'] === partition.trial_id && matches(SHA256, trialDigest)
    ? { ...view, trial: { trial_id: partition.trial_id, trial_manifest_sha256: trialDigest } }
    : undefined;
}

function treatmentExpected(item: StoredItem): JsonObject | undefined {
  const state = item['state'];
  const version = item['version'];
  const versionHolds = typeof version === 'number' && Number.isSafeInteger(version) && version >= 1;
  if (!versionHolds || typeof state !== 'string') {
    return undefined;
  }
  if (state === 'ARMED' || state === 'SAFETY_RELEASED') {
    return { state };
  }
  const identities =
    state === 'COMMITTED_WAITING'
      ? [...COMMIT_FIELDS]
      : SIGNALLED.includes(state)
        ? [...COMMIT_FIELDS, 'signal_caller_event_id']
        : undefined;
  if (!identities?.every((field) => matches(UUID4, item[field]))) {
    return undefined;
  }
  return Object.fromEntries([
    ['state', state],
    ...identities.map((field) => [field, item[field] ?? null]),
  ]) as JsonObject;
}

describe('control item decoder properties', () => {
  it('decodes a config item exactly when every field the controller acts on is well formed', () => {
    const seen = { accepted: 0, refused: 0 };
    fc.assert(
      fc.property(configCase, ({ item, partition }) => {
        const expected = configExpected(item, partition);
        const decoded = decodeControllerConfig(item, partition);
        seen[expected === undefined ? 'refused' : 'accepted'] += 1;
        if (expected === undefined) {
          assert.equal(decoded.ok, false);
          assert.ok(decoded.error.startsWith(`control item ${item.pk}/config: `), decoded.error);
          return;
        }
        assert.deepEqual(decoded, { ok: true, value: expected });
      }),
      fuzzParameters(),
    );
    assert.ok(seen.accepted > 0 && seen.refused > 0, JSON.stringify(seen));
  });

  it('decodes a treatment item exactly when its state, version and implied identities are well formed', () => {
    const seen = { accepted: 0, refused: 0 };
    fc.assert(
      fc.property(treatmentItem, (item) => {
        const expected = treatmentExpected(item);
        const decoded = decodeControllerTreatment(item);
        seen[expected === undefined ? 'refused' : 'accepted'] += 1;
        if (expected === undefined) {
          assert.equal(decoded.ok, false);
          assert.ok(decoded.error.startsWith(`control item ${TRIAL_PK}/treatment: `), decoded.error);
          return;
        }
        assert.deepEqual(decoded, { ok: true, value: expected });
      }),
      fuzzParameters(),
    );
    assert.ok(seen.accepted > 0 && seen.refused > 0, JSON.stringify(seen));
  });
});
