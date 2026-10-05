// `payment` (CTR-RUA-005): the one trial-scoped captured BRL payment (BR-RUA-016, OR-RUA-001).

export interface Payment {
  readonly schema_version: 1;
  readonly record_type: 'payment';
  /** Business identifier, non-empty after trimming; the PoC fixture uses `pay-poc-001`. */
  readonly payment_id: string;
  /** Positive safe integer in minor units (BR-RUA-017). */
  readonly captured_amount_minor: number;
  readonly currency: 'BRL';
}
