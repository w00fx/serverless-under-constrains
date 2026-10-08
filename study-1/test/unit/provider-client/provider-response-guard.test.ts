// readProviderRefundResponse: the hand-written guard of the `provider_refund_response` schema.
// Example cases pin each rule and its message; the properties (totality, and differential
// agreement with the real Ajv schema over near-valid payloads; testing rule 6) are in
// test/fuzz/provider-client/provider-response-guard.fuzz.test.ts (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readProviderRefundResponse } from '../../../src/provider-client/provider-response-guard.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { PROVIDER_REJECTION_REASONS } from '../../../src/record-contract/records/group-a/provider_refund_response.ts';
import {
  FIRST_ATTEMPT_ID,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
} from '../../support/provider-client/provider-client-fixtures.ts';
import {
  GUARD_REJECTED as REJECTED,
  GUARD_SUCCEEDED as SUCCEEDED,
  withoutMember as without,
} from '../../support/provider-client/provider-response-guard-samples.ts';

const RESPONSE_FIELDS =
  'schema_version, record_type, outcome, provider_call_id, attempt_id, provider_request_id, provider_transaction_id, rejection_reason';

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
      [[1], 'payload array [1]; expected a JSON object'],
      ['refund', 'payload string "refund"; expected a JSON object'],
      [{ ...SUCCEEDED, schema_version: { v: 1, w: 2 } }, 'schema_version object {"v":1,"w":2}; expected 1'],
      [{ ...SUCCEEDED, record_type: [] }, 'record_type array []; expected "provider_refund_response"'],
      [null, 'payload null null; expected a JSON object'],
      [{ ...SUCCEEDED, extra: true }, `property string "extra"; expected only ${RESPONSE_FIELDS}`],
      [{ ...SUCCEEDED, schema_version: 2 }, 'schema_version number 2; expected 1'],
      [
        { ...SUCCEEDED, record_type: 'provider_refund_call' },
        'record_type string "provider_refund_call"; expected "provider_refund_response"',
      ],
      [without(SUCCEEDED, 'provider_call_id'), 'provider_call_id absent; expected a lowercase UUIDv4'],
      [
        { ...SUCCEEDED, attempt_id: FIRST_ATTEMPT_ID.toUpperCase() },
        `attempt_id string "${FIRST_ATTEMPT_ID.toUpperCase()}"; expected a lowercase UUIDv4`,
      ],
      [{ ...REJECTED, provider_request_id: 7 }, 'provider_request_id number 7; expected a lowercase UUIDv4'],
      [
        { ...SUCCEEDED, provider_transaction_id: null },
        'provider_transaction_id null null; expected a lowercase UUIDv4',
      ],
      [
        without(SUCCEEDED, 'attempt_id'),
        'SUCCEEDED response without attempt_id; expected attempt_id, provider_request_id and provider_transaction_id',
      ],
      [
        without(SUCCEEDED, 'provider_transaction_id'),
        'SUCCEEDED response without provider_transaction_id; expected attempt_id, provider_request_id and provider_transaction_id',
      ],
      [{ ...SUCCEEDED, rejection_reason: 'SCHEMA_INVALID' }, 'SUCCEEDED response with rejection_reason; expected none'],
      [without(SUCCEEDED, 'outcome'), 'outcome absent; expected "SUCCEEDED" or "REJECTED"'],
      [
        { ...REJECTED, provider_transaction_id: PROVIDER_TRANSACTION_ID },
        'REJECTED response with provider_transaction_id; expected none, because a rejection creates no transaction',
      ],
      [
        without(REJECTED, 'rejection_reason'),
        `rejection_reason absent; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
      ],
      [
        { ...REJECTED, rejection_reason: 'TOO_LATE' },
        `rejection_reason string "TOO_LATE"; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
      ],
    ];
    for (const [value, expected] of cases) {
      assert.equal(guardError(value), expected, JSON.stringify(value));
    }
  });

  // Regression (WP-06 review round 1): a recursive JSON.stringify of the offending value threw
  // RangeError (Maximum call stack size exceeded) at a nesting depth of 10,000, about 20 KB.
  // Owner amendment A-05.3 asks for at least 100,000 levels at every untrusted-input guard.
  it('rejects payloads and fields nested 100,000 deep without throwing', () => {
    const deep = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`) as JsonValue;
    const deepText = `array ${'['.repeat(200)}…[truncated]`;
    assert.equal(guardError(deep), `payload ${deepText}; expected a JSON object`);
    assert.equal(guardError({ ...SUCCEEDED, schema_version: deep }), `schema_version ${deepText}; expected 1`);
    assert.equal(
      guardError({ ...REJECTED, rejection_reason: deep }),
      `rejection_reason ${deepText}; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
    );
    const deepObject = JSON.parse(`${'{"a":'.repeat(100_000)}1${'}'.repeat(100_000)}`) as JsonValue;
    assert.equal(
      guardError({ ...SUCCEEDED, outcome: deepObject }),
      `outcome object ${'{"a":'.repeat(40)}…[truncated]; expected "SUCCEEDED" or "REJECTED"`,
    );
  });

  it('quotes at most 200 characters of an offending string (kernel rendering)', () => {
    const huge = 'X'.repeat(1_000_000);
    const cut = `"${'X'.repeat(199)}…[truncated]`;
    assert.equal(
      guardError({ ...REJECTED, rejection_reason: huge }),
      `rejection_reason string ${cut}; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
    );
    assert.equal(guardError({ ...SUCCEEDED, [huge]: 1 }), `property string ${cut}; expected only ${RESPONSE_FIELDS}`);
  });

  // Owner amendment A-05.2/A-05.3: inherited member names are never fields. JSON.parse makes
  // `__proto__` an own key, so it is an unexpected property like any other.
  it('rejects inherited member names as keys or as enum values', () => {
    const parsed = (text: string): JsonValue => JSON.parse(text) as JsonValue;
    const succeededText = JSON.stringify(SUCCEEDED).slice(1, -1);
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(
        guardError(parsed(`{${succeededText},"${name}":{}}`)),
        `property string "${name}"; expected only ${RESPONSE_FIELDS}`,
        name,
      );
    }
    for (const name of ['toString', 'constructor', '__proto__']) {
      assert.equal(
        guardError({ ...SUCCEEDED, outcome: name }),
        `outcome string "${name}"; expected "SUCCEEDED" or "REJECTED"`,
      );
      assert.equal(
        guardError({ ...REJECTED, rejection_reason: name }),
        `rejection_reason string "${name}"; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
      );
    }
  });

  it('reads only own properties: a field inherited through the prototype is absent', () => {
    const inheriting = (proto: JsonObject, own: JsonObject): JsonValue =>
      Object.assign(Object.create(proto) as JsonObject, own);
    assert.equal(
      guardError(inheriting({ schema_version: 1 }, without(SUCCEEDED, 'schema_version'))),
      'schema_version absent; expected 1',
    );
    assert.equal(
      guardError(inheriting({ record_type: 'provider_refund_response' }, without(SUCCEEDED, 'record_type'))),
      'record_type absent; expected "provider_refund_response"',
    );
    assert.equal(
      guardError(inheriting({ provider_call_id: PROVIDER_CALL_ID }, without(SUCCEEDED, 'provider_call_id'))),
      'provider_call_id absent; expected a lowercase UUIDv4',
    );
    assert.equal(
      guardError(inheriting({ outcome: 'SUCCEEDED' }, without(SUCCEEDED, 'outcome'))),
      'outcome absent; expected "SUCCEEDED" or "REJECTED"',
    );
    assert.equal(
      guardError(
        inheriting({ provider_transaction_id: PROVIDER_TRANSACTION_ID }, without(SUCCEEDED, 'provider_transaction_id')),
      ),
      'SUCCEEDED response without provider_transaction_id; expected attempt_id, provider_request_id and provider_transaction_id',
    );
    assert.equal(
      guardError(inheriting({ rejection_reason: 'AMOUNT_INVALID' }, without(REJECTED, 'rejection_reason'))),
      `rejection_reason absent; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`,
    );
    // Inherited members that would break the response are ignored, as JSON data has none.
    assert.equal(guardError(inheriting({ rejection_reason: 'SCHEMA_INVALID' }, SUCCEEDED)), undefined);
    assert.equal(guardError(inheriting({ provider_transaction_id: PROVIDER_TRANSACTION_ID }, REJECTED)), undefined);
    assert.equal(guardError(inheriting({ attempt_id: 'not-a-uuid' }, REJECTED)), undefined);
  });

  it('rejects a non-finite number with the expected shape (A-05.3)', () => {
    for (const nonFinite of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const error = guardError({ ...SUCCEEDED, schema_version: nonFinite });
      assert.ok(error?.startsWith('schema_version number ') === true && error.endsWith('; expected 1'), error);
      assert.match(
        guardError({ ...REJECTED, provider_request_id: nonFinite }) ?? '',
        /^provider_request_id number .+; expected a lowercase UUIDv4$/u,
      );
    }
  });
});
