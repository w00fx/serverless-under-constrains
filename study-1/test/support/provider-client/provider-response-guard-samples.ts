// Payloads shared by the readProviderRefundResponse example cases
// (test/unit/provider-client/provider-response-guard.test.ts) and its properties
// (test/fuzz/provider-client/provider-response-guard.fuzz.test.ts, Owner amendment A-11).

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
} from './provider-client-fixtures.ts';

/** A schema-valid SUCCEEDED response with every echoed id. */
export const GUARD_SUCCEEDED: JsonObject = {
  schema_version: 1,
  record_type: 'provider_refund_response',
  outcome: 'SUCCEEDED',
  provider_call_id: PROVIDER_CALL_ID,
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
  provider_transaction_id: PROVIDER_TRANSACTION_ID,
};

/** A schema-valid REJECTED response without echoed ids. */
export const GUARD_REJECTED: JsonObject = {
  schema_version: 1,
  record_type: 'provider_refund_response',
  outcome: 'REJECTED',
  provider_call_id: PROVIDER_CALL_ID,
  rejection_reason: 'AUTHORIZATION_FAILED',
};

/**
 * A copy of the object without one member.
 *
 * @example
 * withoutMember(GUARD_SUCCEEDED, 'outcome'); // every member but outcome
 */
export function withoutMember(value: JsonObject, name: string): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== name));
}
