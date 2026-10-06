// Settlements and bounds shared by the parseProviderResponse example cases
// (test/unit/provider-client/provider-response.test.ts) and its properties
// (test/fuzz/provider-client/provider-response.fuzz.test.ts, Owner amendment A-11).

import assert from 'node:assert/strict';

import type { ProviderTransportResult } from '../../../src/provider-client/provider-invocation-port.ts';
import type { ExpectedProviderResponse } from '../../../src/provider-client/provider-response.ts';
import { parseProviderResponse } from '../../../src/provider-client/provider-response.ts';
import {
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  invokeResponse,
  jsonBytes,
  PROVIDER_CALL_ID,
  PROVIDER_TRANSACTION_ID,
} from './provider-client-fixtures.ts';

/** The response the first attempt of the fixtures expects from version 7. */
export const EXPECTED_RESPONSE: ExpectedProviderResponse = {
  qualifier: '7',
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
};

/** A schema-valid SUCCEEDED payload that echoes the expected ids. */
export const SUCCEEDED_PAYLOAD = {
  schema_version: 1,
  record_type: 'provider_refund_response',
  outcome: 'SUCCEEDED',
  provider_call_id: PROVIDER_CALL_ID,
  attempt_id: FIRST_ATTEMPT_ID,
  provider_request_id: FIRST_PROVIDER_REQUEST_ID,
  provider_transaction_id: PROVIDER_TRANSACTION_ID,
} as const;

/**
 * A response settlement of the SUCCEEDED payload with some fields replaced.
 *
 * @example
 * respondWith({ status_code: 500 }); // a response settlement whose status is 500
 */
export function respondWith(
  overrides: Partial<Extract<ProviderTransportResult, { kind: 'response' }>>,
): ProviderTransportResult {
  return { ...invokeResponse(jsonBytes(SUCCEEDED_PAYLOAD)), ...overrides };
}

/**
 * The failure of a settlement the parser must classify as failed; fails the test otherwise.
 *
 * @example
 * failedParseOf(respondWith({ status_code: 500 })).code; // 'MALFORMED_RESPONSE'
 */
export function failedParseOf(result: ProviderTransportResult): { readonly code: string; readonly detail: string } {
  const parsed = parseProviderResponse(result, EXPECTED_RESPONSE);
  assert.ok(parsed.kind === 'failed', parsed.kind);
  return parsed.failure;
}
