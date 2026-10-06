// The registry item codec and the `trial_registration` guard (design D-21, §9.3): the key of each
// variant's single item, and a total check that accepts exactly the schema's registrations.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeJson } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  TRIAL_REGISTRY_ACTIVE_SK,
  parseTrialRegistration,
  toTrialRegistryItem,
  trialRegistryItemKey,
} from '../../../src/trial-message/trial-registry.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';
import { runRegistration, validationRegistration, withoutFields } from './support/trial-message-fixtures.ts';

function registrationObject(overrides: JsonObject = {}): JsonObject {
  return { ...(runRegistration() as unknown as JsonObject), ...overrides };
}

function refusal(value: JsonValue): string {
  const parsed = parseTrialRegistration(value);
  assert.equal(parsed.ok, false, `expected a refusal of ${describeJson(value)}`);
  return parsed.error;
}

describe('trial registry keys', () => {
  it('keys each variant under registry#<variant_id> and the sort key active', () => {
    assert.equal(TRIAL_REGISTRY_ACTIVE_SK, 'active');
    assert.deepEqual(trialRegistryItemKey('conventional'), { pk: 'registry#conventional', sk: 'active' });
    assert.deepEqual(trialRegistryItemKey('durable'), { pk: 'registry#durable', sk: 'active' });
  });

  it('stores a registration as the record under its variant key', () => {
    assert.deepEqual(toTrialRegistryItem(runRegistration()), {
      ...runRegistration(),
      pk: 'registry#conventional',
      sk: 'active',
    });
  });
});

describe('parseTrialRegistration', () => {
  it('accepts a run and a variant-validation registration, rebuilding exactly their fields', () => {
    assert.deepEqual(parseTrialRegistration(registrationObject()), { ok: true, value: runRegistration() });
    const validation = validationRegistration() as unknown as JsonObject;
    assert.deepEqual(parseTrialRegistration(validation), { ok: true, value: validationRegistration() });
  });

  it('refuses a value that is no JSON object', () => {
    assert.equal(refusal([1]), 'trial registration is array [1]; expected a JSON object');
    assert.equal(refusal(null), 'trial registration is null null; expected a JSON object');
  });

  it('refuses an unexpected property, inherited names included', () => {
    assert.match(refusal(registrationObject({ extra: 1 })), /unexpected property "extra"/);
    const text = JSON.stringify(registrationObject()).replace('{', '{"__proto__":{},');
    assert.match(refusal(JSON.parse(text) as JsonValue), /unexpected property "__proto__"/);
  });

  it('refuses both, neither or a malformed execution identity', () => {
    const expected = /expected exactly one lowercase UUIDv4$/;
    assert.match(refusal(registrationObject({ variant_validation_id: runRegistration().trial_id })), expected);
    assert.match(refusal(withoutFields(registrationObject(), 'run_id')), expected);
    assert.match(refusal(registrationObject({ run_id: 'run-1' })), expected);
  });

  it('names the first field that breaks its rule', () => {
    const cases: readonly (readonly [JsonObject, string])[] = [
      [registrationObject({ schema_version: 2 }), 'schema_version number 2; expected 1'],
      [
        registrationObject({ record_type: 'trial_message' }),
        'record_type string "trial_message"; expected "trial_registration"',
      ],
      [registrationObject({ variant_id: 'probe' }), 'variant_id string "probe"; expected "conventional" or "durable"'],
      [
        registrationObject({ execution_manifest_sha256: 'A'.repeat(64) }),
        `execution_manifest_sha256 string "${'A'.repeat(64)}"; expected 64 lowercase hex characters`,
      ],
      [registrationObject({ trial_id: 7 }), 'trial_id number 7; expected a lowercase UUIDv4'],
      [
        registrationObject({ trial_manifest_sha256: 'b' }),
        'trial_manifest_sha256 string "b"; expected 64 lowercase hex characters',
      ],
      [
        registrationObject({ registry_version: 0 }),
        'registry_version number 0; expected an integer from 1 to 9007199254740991',
      ],
      [
        registrationObject({ registry_version: 1.5 }),
        'registry_version number 1.5; expected an integer from 1 to 9007199254740991',
      ],
      [
        registrationObject({ registry_version: 2 ** 53 }),
        'registry_version number 9007199254740992; expected an integer from 1 to 9007199254740991',
      ],
      [
        registrationObject({ registry_version: '1' }),
        'registry_version string "1"; expected an integer from 1 to 9007199254740991',
      ],
      [
        registrationObject({ registered_at: '2026-02-30T00:00:00.000Z' }),
        'registered_at string "2026-02-30T00:00:00.000Z"; expected a UTC timestamp with milliseconds',
      ],
      [
        withoutFields(registrationObject(), 'registered_at'),
        'registered_at absent; expected a UTC timestamp with milliseconds',
      ],
    ];
    for (const [value, detail] of cases) {
      assert.equal(refusal(value), `trial registration ${detail}`);
    }
  });

  it('accepts the largest safe registry version', () => {
    assert.equal(parseTrialRegistration(registrationObject({ registry_version: Number.MAX_SAFE_INTEGER })).ok, true);
  });

  it(`stays total on values nested ${String(DEEP_NESTING)} levels deep and on non-finite numbers`, () => {
    assert.match(refusal(parsedTower('mixed')), /^trial registration is array/);
    assert.ok(refusal(registrationObject({ trial_id: parsedTower('object') })).length < 1_000);
    assert.match(
      refusal(registrationObject({ registry_version: Number.POSITIVE_INFINITY })),
      /registry_version number Infinity/,
    );
  });
});
