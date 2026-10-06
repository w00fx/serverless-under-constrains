// The REJECTED provider response (BR-RUA-018): the call's fresh `provider_call_id`, the rejection
// reason, and the caller identities echoed only when they are well-formed UUIDv4 values. Shared by
// the trial-partition rejection and the unattributed-call rejection (A-09).

import { isUuid4 } from '../record-contract/identifiers.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import type { JsonValue, Uuid4 } from '../record-contract/primitives.ts';
import type { ProviderRefundResponse } from '../record-contract/records/group-a/provider_refund_response.ts';
import type { ProviderRejectionReason } from '../record-contract/records/group-b/vocabulary.ts';

/**
 * The response to a rejected call.
 *
 * @example
 * rejectedResponse(providerCallId, raw, 'SCHEMA_INVALID'); // { outcome: 'REJECTED', rejection_reason: 'SCHEMA_INVALID', ... }
 */
export function rejectedResponse(
  providerCallId: Uuid4,
  raw: JsonValue,
  reason: ProviderRejectionReason,
): ProviderRefundResponse {
  return {
    schema_version: 1,
    record_type: 'provider_refund_response',
    outcome: 'REJECTED',
    provider_call_id: providerCallId,
    ...echoedIdentities(raw),
    rejection_reason: reason,
  };
}

function echoedIdentities(raw: JsonValue): { readonly attempt_id?: Uuid4; readonly provider_request_id?: Uuid4 } {
  const attemptId = isJsonObject(raw) ? raw['attempt_id'] : undefined;
  const requestId = isJsonObject(raw) ? raw['provider_request_id'] : undefined;
  return {
    ...(isUuid4(attemptId) ? { attempt_id: attemptId } : {}),
    ...(isUuid4(requestId) ? { provider_request_id: requestId } : {}),
  };
}
