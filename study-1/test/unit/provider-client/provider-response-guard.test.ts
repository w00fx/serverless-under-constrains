// readProviderRefundResponse: the hand-written guard of the `provider_refund_response` schema.
// Example cases pin each rule and its message; a property test keeps the guard in differential
// agreement with the real Ajv schema over near-valid payloads (testing rule 6: a validator of
// untrusted bytes; design §12.5 hand-written guards). Runs FC_RUNS cases.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { readProviderRefundResponse } from '../../../src/provider-client/provider-response-guard.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { PROVIDER_REJECTION_REASONS } from '../../../src/record-contract/records/group-a/provider_refund_response.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
} from '../../support/provider-client/provider-client-fixtures.ts';

const SUCCEEDED: JsonObject = {
  schema_version: 1,
  record_type: 'provider_refund_response',
  outcome: 'SUCCEEDED',
  provider_call_id: PROVIDER_CALL_ID,
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
  provider_transaction_id: PROVIDER_TRANSACTION_ID,
};

const REJECTED: JsonObject = {
  schema_version: 1,
  record_type: 'provider_refund_response',
  outcome: 'REJECTED',
  provider_call_id: PROVIDER_CALL_ID,
  rejection_reason: 'AUTHORIZATION_FAILED',
};

function without(value: JsonObject, name: string): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== name));
}

function guardError(value: JsonValue): string | undefined {
  const result = readProviderRefundResponse(value);
  return result.ok ? undefined : result.error;
}

describe('readProviderRefundResponse', () => {
  it('accepts a SUCCEEDED response and a REJECTED response with or without echoed ids', () => {
    assert.deepEqual(readProviderRefundResponse(SUCCEEDED), { ok: true, value: SUCCEEDED });
    assert.equal(readProviderRefundResponse(REJECTED).ok, true);
    assert.equal(readProviderRefundResponse({ ...REJECTED, attempt_id: FIRST_ATTEMPT_ID }).ok, true);
  });

  it('names the first broken rule with the offending value and the expected shape', () => {
    const cases: readonly (readonly [JsonValue, string])[] = [
      [[1], 'payload an array of length 1; expected a JSON object'],
      ['refund', 'payload "refund"; expected a JSON object'],
      [{ ...SUCCEEDED, schema_version: { v: 1, w: 2 } }, 'schema_version an object with 2 key(s); expected 1'],
      [{ ...SUCCEEDED, record_type: [] }, 'record_type an array of length 0; expected "provider_refund_response"'],
      [null, 'payload null; expected a JSON object'],
      [
        { ...SUCCEEDED, extra: true },
        'property "extra"; expected only schema_version, record_type, outcome, provider_call_id, attempt_id, provider_request_id, provider_transaction_id, rejection_reason',
      ],
      [{ ...SUCCEEDED, schema_version: 2 }, 'schema_version 2; expected 1'],
      [
        { ...SUCCEEDED, record_type: 'provider_refund_call' },
        'record_type "provider_refund_call"; expected "provider_refund_response"',
      ],
      [without(SUCCEEDED, 'provider_call_id'), 'provider_call_id undefined; expected a lowercase UUIDv4'],
      [
        { ...SUCCEEDED, attempt_id: FIRST_ATTEMPT_ID.toUpperCase() },
        `attempt_id "${FIRST_ATTEMPT_ID.toUpperCase()}"; expected a lowercase UUIDv4`,
      ],
      [{ ...REJECTED, provider_request_id: 7 }, 'provider_request_id 7; expected a lowercase UUIDv4'],
      [{ ...SUCCEEDED, provider_transaction_id: null }, 'provider_transaction_id null; expected a lowercase UUIDv4'],
      [
        without(SUCCEEDED, 'attempt_id'),
        'SUCCEEDED response without attempt_id; expected attempt_id, provider_request_id and provider_transaction_id',
      ],
      [
        without(SUCCEEDED, 'provider_transaction_id'),
        'SUCCEEDED response without provider_transaction_id; expected attempt_id, provider_request_id and provider_transaction_id',
      ],
      [{ ...SUCCEEDED, rejection_reason: 'SCHEMA_INVALID' }, 'SUCCEEDED response with rejection_reason; expected none'],
      [without(SUCCEEDED, 'outcome'), 'outcome undefined; expected "SUCCEEDED" or "REJECTED"'],
      [
        { ...REJECTED, provider_transaction_id: PROVIDER_TRANSACTION_ID },
        'REJECTED response with provider_transaction_id; expected none, because a rejection creates no transaction',
      ],
      [
        without(REJECTED, 'rejection_reason'),
        `rejection_reason undefined; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
      ],
      [
        { ...REJECTED, rejection_reason: 'TOO_LATE' },
        `rejection_reason "TOO_LATE"; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
      ],
    ];
    for (const [value, expected] of cases) {
      assert.equal(guardError(value), expected, JSON.stringify(value));
    }
  });

  // Regression (WP-06 review round 1): a recursive JSON.stringify of the offending value threw
  // RangeError (Maximum call stack size exceeded) at a nesting depth of 10,000, about 20 KB.
  it('rejects deeply nested payloads and fields without throwing', () => {
    const deep = JSON.parse(`${'['.repeat(10_000)}${']'.repeat(10_000)}`) as JsonValue;
    assert.equal(guardError(deep), 'payload an array of length 1; expected a JSON object');
    assert.equal(guardError({ ...SUCCEEDED, schema_version: deep }), 'schema_version an array of length 1; expected 1');
    assert.equal(
      guardError({ ...REJECTED, rejection_reason: deep }),
      `rejection_reason an array of length 1; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
    );
    const deepObject = JSON.parse(`${'{"a":'.repeat(10_000)}1${'}'.repeat(10_000)}`) as JsonValue;
    assert.equal(
      guardError({ ...SUCCEEDED, outcome: deepObject }),
      'outcome an object with 1 key(s); expected "SUCCEEDED" or "REJECTED"',
    );
  });

  it('repeats at most 256 characters of an offending string', () => {
    const huge = 'X'.repeat(1_000_000);
    assert.equal(
      guardError({ ...REJECTED, rejection_reason: huge }),
      `rejection_reason "${'X'.repeat(255)}... (1000002 chars); expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
    );
    assert.equal(
      guardError({ ...SUCCEEDED, [huge]: 1 }),
      `property "${'X'.repeat(255)}... (1000002 chars); expected only schema_version, record_type, outcome, provider_call_id, attempt_id, provider_request_id, provider_transaction_id, rejection_reason`,
    );
  });

  it('is total over arbitrary JSON values, deep ones included, with bounded errors (property)', () => {
    const value = fc.oneof(
      fc.jsonValue({ depthSize: 'xlarge', maxDepth: 50 }) as fc.Arbitrary<JsonValue>,
      fc
        .tuple(
          fc.constantFrom(...Object.keys(SUCCEEDED), 'rejection_reason'),
          fc.jsonValue() as fc.Arbitrary<JsonValue>,
        )
        .map(([name, field]): JsonValue => ({ ...SUCCEEDED, [name]: field })),
      fc.nat({ max: 20_000 }).map((depth) => JSON.parse(`${'['.repeat(depth)}1${']'.repeat(depth)}`) as JsonValue),
    );
    fc.assert(
      fc.property(value, (candidate) => {
        const result = readProviderRefundResponse(candidate);
        // The longest message names one bounded value plus a fixed expected shape.
        assert.ok(result.ok || result.error.length <= 600, result.ok ? '' : result.error.slice(0, 200));
      }),
      fuzzParameters(),
    );
  });

  it('agrees with the Ajv schema on near-valid payloads (property)', () => {
    const validator = createRecordValidator();
    const fieldValue = fc.oneof(
      fc.constantFrom<JsonValue>(
        1,
        2,
        null,
        true,
        '',
        'SUCCEEDED',
        'REJECTED',
        'provider_refund_response',
        'AMOUNT_INVALID',
        PROVIDER_CALL_ID,
        FIRST_ATTEMPT_ID,
        FIRST_ATTEMPT_ID.toUpperCase(),
        [],
        {},
      ),
      fc.string(),
      fc.integer(),
    );
    const names = fc.constantFrom(...Object.keys(SUCCEEDED), 'rejection_reason', 'unexpected_property');
    const mutation = fc.oneof(
      fc.record({ op: fc.constant('drop' as const), name: names }),
      fc.record({ op: fc.constant('set' as const), name: names, value: fieldValue }),
    );
    const payload = fc
      .tuple(fc.constantFrom(SUCCEEDED, REJECTED), fc.array(mutation, { maxLength: 3 }))
      .map(([base, mutations]) =>
        mutations.reduce<JsonObject>(
          (current, step) =>
            step.op === 'drop' ? without(current, step.name) : { ...current, [step.name]: step.value },
          base,
        ),
      );
    const seen = { valid: 0, invalid: 0 };
    fc.assert(
      fc.property(payload, (value) => {
        const schemaValid = validator.validateAs('provider_refund_response', value).valid;
        seen[schemaValid ? 'valid' : 'invalid'] += 1;
        assert.equal(readProviderRefundResponse(value).ok, schemaValid, JSON.stringify(value));
      }),
      fuzzParameters(),
    );
    // Both verdicts must occur, or the agreement would be vacuous.
    assert.ok(seen.valid > 0 && seen.invalid > 0, JSON.stringify(seen));
  });
});
