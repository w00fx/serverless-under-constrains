// The refund every variant requests, from the OR-RUA-001 financial fixture. BR-RUA-036 puts only
// the business identity (`payment_id`, `refund_request_id`) in the published message, and a
// variant may not read the control table or the approved decision (BR-RUA-018), so the amount
// and currency a variant's attempt carries come from this fixture. Admission freezes the same
// fixture as the approved decision; WP-20 decision log row 1 records this binding for the Owner.

/** The approved full refund of OR-RUA-001: what a variant asks the provider to refund. */
export interface ApprovedRefund {
  readonly payment_id: string;
  readonly refund_request_id: string;
  /** Positive minor units; equal to the captured amount (only full refunds exist). */
  readonly amount_minor: number;
  readonly currency: 'BRL';
}

/**
 * OR-RUA-001: payment `pay-poc-001`, refund request `ref-poc-001`, 10000 minor units of BRL.
 *
 * @example
 * client.performAttempt({ ...input, amount_minor: OR_RUA_001_REFUND.amount_minor, currency: OR_RUA_001_REFUND.currency });
 */
export const OR_RUA_001_REFUND: ApprovedRefund = {
  payment_id: 'pay-poc-001',
  refund_request_id: 'ref-poc-001',
  amount_minor: 10_000,
  currency: 'BRL',
};
