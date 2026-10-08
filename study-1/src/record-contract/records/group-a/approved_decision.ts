// `approved_decision` (CTR-RUA-006): the fixed resolved authorization for one full refund. It
// never enters the controlled provider (design §5.4 boundary rule).

export interface ApprovedDecision {
  readonly schema_version: 1;
  readonly record_type: 'approved_decision';
  readonly refund_request_id: string;
  readonly payment_id: string;
  readonly decision: 'APPROVED';
  /** Equal to the payment's captured amount: only full refunds exist (BR-RUA-017, D-31). */
  readonly approved_amount_minor: number;
  readonly currency: 'BRL';
}
