// A hand-written guard of the `provider_refund_response` schema (catalogue group A). The caller
// reads the provider's payload with it instead of compiling the Ajv validator inside the
// attempt, and a unit property test keeps it in differential agreement with the real schema
// (design §12.5 pattern for hand-written guards). The payload is untrusted bytes, so the guard is
// total over every JSON value: it never recurses into the value, and every offending value it
// names is rendered bounded and non-recursively (`offending-value.ts`; WP-06 review round 1,
// where a 10,000-deep array overflowed the stack inside a recursive `JSON.stringify`).

import { isJsonObject } from '../record-contract/json-value.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import type { JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import type { ProviderRefundResponse } from '../record-contract/records/group-a/provider_refund_response.ts';
import { PROVIDER_REJECTION_REASONS } from '../record-contract/records/group-a/provider_refund_response.ts';
import { describeJsonValue } from './offending-value.ts';

const RESPONSE_PROPERTIES: ReadonlySet<string> = new Set([
  'schema_version',
  'record_type',
  'outcome',
  'provider_call_id',
  'attempt_id',
  'provider_request_id',
  'provider_transaction_id',
  'rejection_reason',
]);

const OPTIONAL_UUID_PROPERTIES = ['attempt_id', 'provider_request_id', 'provider_transaction_id'] as const;

/**
 * Reads a parsed JSON value as a `provider_refund_response`, or names the first schema rule it
 * breaks (with the offending value and the expected shape).
 *
 * @example
 * readProviderRefundResponse({ schema_version: 1, record_type: 'provider_refund_response', outcome: 'REJECTED',
 *   provider_call_id, rejection_reason: 'PAYMENT_NOT_FOUND' }).ok; // true
 */
export function readProviderRefundResponse(value: JsonValue): Result<ProviderRefundResponse, string> {
  if (!isJsonObject(value)) {
    return { ok: false, error: `payload ${describeJsonValue(value)}; expected a JSON object` };
  }
  const problem = envelopeProblem(value) ?? outcomeProblem(value);
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }
  return { ok: true, value: value as unknown as ProviderRefundResponse };
}

function envelopeProblem(value: JsonObject): string | undefined {
  const unknownProperty = Object.keys(value).find((name) => !RESPONSE_PROPERTIES.has(name));
  if (unknownProperty !== undefined) {
    return `property ${describeJsonValue(unknownProperty)}; expected only ${[...RESPONSE_PROPERTIES].join(', ')}`;
  }
  if (value['schema_version'] !== 1) {
    return `schema_version ${describeJsonValue(value['schema_version'])}; expected 1`;
  }
  if (value['record_type'] !== 'provider_refund_response') {
    return `record_type ${describeJsonValue(value['record_type'])}; expected "provider_refund_response"`;
  }
  if (!isUuid4(value['provider_call_id'])) {
    return `provider_call_id ${describeJsonValue(value['provider_call_id'])}; expected a lowercase UUIDv4`;
  }
  const badId = OPTIONAL_UUID_PROPERTIES.find((name) => name in value && !isUuid4(value[name]));
  return badId === undefined ? undefined : `${badId} ${describeJsonValue(value[badId])}; expected a lowercase UUIDv4`;
}

function outcomeProblem(value: JsonObject): string | undefined {
  const outcome = value['outcome'];
  if (outcome === 'SUCCEEDED') {
    const missing = OPTIONAL_UUID_PROPERTIES.find((name) => !(name in value));
    if (missing !== undefined) {
      return `SUCCEEDED response without ${missing}; expected attempt_id, provider_request_id and provider_transaction_id`;
    }
    return 'rejection_reason' in value ? 'SUCCEEDED response with rejection_reason; expected none' : undefined;
  }
  if (outcome !== 'REJECTED') {
    return `outcome ${describeJsonValue(outcome)}; expected "SUCCEEDED" or "REJECTED"`;
  }
  if ('provider_transaction_id' in value) {
    return 'REJECTED response with provider_transaction_id; expected none, because a rejection creates no transaction';
  }
  const reason = value['rejection_reason'];
  if (!(PROVIDER_REJECTION_REASONS as readonly JsonValue[]).includes(reason ?? null)) {
    return `rejection_reason ${describeJsonValue(reason)}; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`;
  }
  return undefined;
}
