// `provider_refund_response` (BR-RUA-018): the business payload the provider returns. Every
// received call has a provider-generated `provider_call_id`, including a rejected call.

import type { Uuid4 } from '../../primitives.ts';

export const PROVIDER_REFUND_OUTCOMES = ['SUCCEEDED', 'REJECTED'] as const;
export type ProviderRefundOutcome = (typeof PROVIDER_REFUND_OUTCOMES)[number];

/** The acceptance conditions of BR-RUA-018, in the design §9.10 evaluation order. */
export const PROVIDER_REJECTION_REASONS = [
  'AUTHORIZATION_FAILED',
  'SCHEMA_INVALID',
  'EXECUTION_IDENTITY_MISMATCH',
  'IDENTITY_STRUCTURE_INVALID',
  'PAYMENT_NOT_FOUND',
  'AMOUNT_INVALID',
  'CURRENCY_MISMATCH',
] as const;
export type ProviderRejectionReason = (typeof PROVIDER_REJECTION_REASONS)[number];

export interface ProviderRefundSucceeded {
  readonly schema_version: 1;
  readonly record_type: 'provider_refund_response';
  readonly outcome: 'SUCCEEDED';
  readonly provider_call_id: Uuid4;
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
  readonly provider_transaction_id: Uuid4;
}

export interface ProviderRefundRejected {
  readonly schema_version: 1;
  readonly record_type: 'provider_refund_response';
  readonly outcome: 'REJECTED';
  readonly provider_call_id: Uuid4;
  /** Echoed only when the call carried a structurally valid lowercase UUIDv4. */
  readonly attempt_id?: Uuid4;
  /** Echoed only when the call carried a structurally valid lowercase UUIDv4. */
  readonly provider_request_id?: Uuid4;
  readonly rejection_reason: ProviderRejectionReason;
}

export type ProviderRefundResponse = ProviderRefundSucceeded | ProviderRefundRejected;
