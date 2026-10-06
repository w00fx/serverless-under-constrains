// Property-based tests of the trial-registry guard (testing rule 6; design D-21): the registry
// item is read back from storage, so it is untrusted until checked. The hand-written guard is
// checked differentially against the catalogue's Ajv validator on near-valid registrations, and
// is total over arbitrary JSON, values nested far deeper than the call stack and non-finite
// numbers (Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { describeJson } from '../../../src/record-contract/json-value.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { parseTrialRegistration } from '../../../src/trial-message/trial-registry.ts';
import { deepTowerArbitrary } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  MANIFEST_SHA,
  RUN_ID,
  TRIAL_ID,
  VALIDATION_ID,
  runRegistration,
  validationRegistration,
} from '../../unit/trial-message/support/trial-message-fixtures.ts';
import { nearValidObjects } from './support/near-valid-objects.ts';

const validator = createRecordValidator();

const boundaryValue: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(
    0,
    1,
    2,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    '',
    '1',
    'conventional',
    'durable',
    'probe',
    'trial_registration',
    'trial_message',
    '2026-10-05T12:00:00.000Z',
    '2026-02-30T12:00:00.000Z',
    '2026-10-05T12:00:00Z',
    null,
    true,
    [],
    {},
    RUN_ID,
    VALIDATION_ID,
    TRIAL_ID,
    RUN_ID.toUpperCase(),
    MANIFEST_SHA,
    MANIFEST_SHA.slice(1),
  ),
  fc.uuid({ version: 4 }),
  fc.stringMatching(/^[0-9a-f]{64}$/u),
  fc.string({ maxLength: 6 }),
  fc.integer(),
  fc.double(),
);

const nearValidRegistration: fc.Arbitrary<JsonObject> = fc
  .constantFrom(runRegistration(), validationRegistration())
  .chain((base) => nearValidObjects(base as unknown as JsonObject, ['run_id', 'variant_validation_id'], boundaryValue));

describe('trial registration guard properties', () => {
  it('accepts exactly what the trial_registration schema accepts', () => {
    const seen = { accepted: 0, refused: 0 };
    fc.assert(
      fc.property(nearValidRegistration, (value) => {
        const expected = validator.validateAs('trial_registration', value).valid;
        seen[expected ? 'accepted' : 'refused'] += 1;
        const parsed = parseTrialRegistration(value);
        assert.equal(parsed.ok, expected, describeJson(value));
        if (parsed.ok) {
          assert.deepEqual(parsed.value, value);
        }
      }),
      fuzzParameters(),
    );
    assert.ok(seen.accepted > 0 && seen.refused > 0, JSON.stringify(seen));
  });

  it('judges any JSON value without throwing, and names the offending value boundedly', () => {
    const anyValue = fc.oneof(
      nearValidRegistration,
      fc.jsonValue() as fc.Arbitrary<JsonValue>,
      deepTowerArbitrary(),
      deepTowerArbitrary().map((tower) => ({ ...(runRegistration() as unknown as JsonObject), trial_id: tower })),
    );
    fc.assert(
      fc.property(anyValue, (value) => {
        const parsed = parseTrialRegistration(value);
        if (!parsed.ok) {
          assert.match(parsed.error, /^trial registration \S/);
          assert.ok(parsed.error.length < 2_000);
        }
      }),
      fuzzParameters(),
    );
  });
});
