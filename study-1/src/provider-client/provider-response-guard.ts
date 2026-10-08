// A hand-written guard of the `provider_refund_response` schema (catalogue group A). The caller
// reads the provider's payload with it instead of compiling the Ajv validator inside the
// attempt, and a unit property test keeps it in differential agreement with the real schema
// (design §12.5 pattern for hand-written guards). The payload is untrusted bytes, so the guard is
// total over every JSON value (Owner amendment A-05.2): it never recurses into the value, it
// reads only own properties (`Object.hasOwn`), so an inherited name such as `constructor` or
// `toString` is never mistaken for a field, and every offending value it names is rendered
// through the kernel's bounded, iterative `describeJson` (A-05.1; WP-06 review rounds 1 and 2).

import { describeJson, isJsonObject } from '../record-contract/json-value.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import type { JsonObject, JsonValue, Result } from '../record-contract/primitives.ts';
import type { ProviderRefundResponse } from '../record-contract/records/group-a/provider_refund_response.ts';
import { PROVIDER_REJECTION_REASONS } from '../record-contract/records/group-a/provider_refund_response.ts';

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
    return { ok: false, error: `payload ${describeJson(value)}; expected a JSON object` };
  }
  const problem = envelopeProblem(value) ?? outcomeProblem(value);
  if (problem !== undefined) {
    return { ok: false, error: problem };
  }
  return { ok: true, value: value as unknown as ProviderRefundResponse };
}

// The value of an own property, or undefined; never a member inherited from Object.prototype.
function ownField(value: JsonObject, name: string): JsonValue | undefined {
  return Object.hasOwn(value, name) ? value[name] : undefined;
}

function envelopeProblem(value: JsonObject): string | undefined {
  const unknownProperty = Object.keys(value).find((name) => !RESPONSE_PROPERTIES.has(name));
  if (unknownProperty !== undefined) {
    return `property ${describeJson(unknownProperty)}; expected only ${[...RESPONSE_PROPERTIES].join(', ')}`;
  }
  const schemaVersion = ownField(value, 'schema_version');
  if (schemaVersion !== 1) {
    return `schema_version ${describeJson(schemaVersion)}; expected 1`;
  }
  const recordType = ownField(value, 'record_type');
  if (recordType !== 'provider_refund_response') {
    return `record_type ${describeJson(recordType)}; expected "provider_refund_response"`;
  }
  const providerCallId = ownField(value, 'provider_call_id');
  if (!isUuid4(providerCallId)) {
    return `provider_call_id ${describeJson(providerCallId)}; expected a lowercase UUIDv4`;
  }
  const badId = OPTIONAL_UUID_PROPERTIES.find((name) => Object.hasOwn(value, name) && !isUuid4(value[name]));
  return badId === undefined ? undefined : `${badId} ${describeJson(value[badId])}; expected a lowercase UUIDv4`;
}

function outcomeProblem(value: JsonObject): string | undefined {
  const outcome = ownField(value, 'outcome');
  if (outcome === 'SUCCEEDED') {
    const missing = OPTIONAL_UUID_PROPERTIES.find((name) => !Object.hasOwn(value, name));
    if (missing !== undefined) {
      return `SUCCEEDED response without ${missing}; expected attempt_id, provider_request_id and provider_transaction_id`;
    }
    return Object.hasOwn(value, 'rejection_reason')
      ? 'SUCCEEDED response with rejection_reason; expected none'
      : undefined;
  }
  if (outcome !== 'REJECTED') {
    return `outcome ${describeJson(outcome)}; expected "SUCCEEDED" or "REJECTED"`;
  }
  if (Object.hasOwn(value, 'provider_transaction_id')) {
    return 'REJECTED response with provider_transaction_id; expected none, because a rejection creates no transaction';
  }
  const reason = ownField(value, 'rejection_reason');
  if (!(PROVIDER_REJECTION_REASONS as readonly JsonValue[]).includes(reason ?? null)) {
    return `rejection_reason ${describeJson(reason)}; expected one of ${PROVIDER_REJECTION_REASONS.join(', ')}`;
  }
  return undefined;
}
