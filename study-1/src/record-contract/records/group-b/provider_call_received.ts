// Catalogue group B row 29 (design §6.2): every received call gets a fresh provider_call_id,
// rejected calls included (BR-RUA-018).

import type { EventEnvelope } from '../../envelope.ts';
import type { Sha256Hex, Uuid4 } from '../../primitives.ts';

/**
 * Schema: `schemas/group-b/provider_call_received.schema.json`. Caller identifiers are copied
 * verbatim when the request carried them as strings, before any shape check, so they are plain
 * strings here; `provider_call_accepted` carries the checked values.
 */
export interface ProviderCallReceived extends EventEnvelope<'provider_call_received'> {
  readonly source: 'refund_provider';
  readonly provider_call_id: Uuid4;
  /**
   * SHA-256 of the canonical JSON of the parsed request: the Lambda runtime hands the provider a
   * parsed payload, never the raw invocation bytes (refund-provider `receivedBody`).
   */
  readonly raw_request_sha256: Sha256Hex;
  readonly caller_id?: string;
  readonly attempt_id?: string;
  readonly provider_request_id?: string;
  readonly refund_request_id?: string;
  readonly payment_id?: string;
}
