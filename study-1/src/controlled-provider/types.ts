import type { PaymentRecord, PrimaryEvent } from "../protocol-records/types.ts";

export type Principal = "variant" | "independent";
export type ProviderOperation = "refund" | "read_ledger" | "read_treatment_state";
export type Scenario = "CONTROL" | "COMMIT_THEN_TIMEOUT";
export type TreatmentStateName = "UNARMED" | "ARMED" | "COMMITTED_WAITING";

export type ExecutionBindingKey = "run_id" | "transport_probe_id" | "variant_validation_id";

export type RefundCall = {
  schema_version: 1;
  record_type: "refund_call";
  trial_id: string;
  trial_manifest_sha256: string;
  attempt_id: string;
  provider_request_id: string;
  payment_id: string;
  refund_request_id: string;
  amount_minor: number;
  currency: "BRL";
  run_id?: string;
  transport_probe_id?: string;
  variant_validation_id?: string;
};

export type RefundTransaction = {
  schema_version: 1;
  record_type: "refund_transaction";
  provider_transaction_id: string;
  provider_call_id: string;
  provider_commit_id: string;
  trial_id: string;
  trial_manifest_sha256: string;
  attempt_id: string;
  provider_request_id: string;
  payment_id: string;
  refund_request_id: string;
  amount_minor: number;
  currency: "BRL";
  status: "SUCCEEDED";
  committed_at: string;
  run_id?: string;
  transport_probe_id?: string;
  variant_validation_id?: string;
};

export type TreatmentRecord = {
  schema_version: 1;
  record_type: "treatment_state";
  trial_id: string;
  state: TreatmentStateName;
  provider_commit_id?: string;
  attempt_id?: string;
  provider_request_id?: string;
  provider_call_id?: string;
  provider_transaction_id?: string;
};

export type ActiveExecution = {
  trial_id: string;
  trial_manifest_sha256: string;
  scenario: Scenario;
  run_id?: string;
  transport_probe_id?: string;
  variant_validation_id?: string;
};

export type ProviderIds = {
  provider_call_id: string;
  provider_transaction_id: string;
  provider_commit_id: string;
  event_id: string;
  source_instance_id: string;
};

export type ReleasePort = (context: {
  provider_commit_id: string;
  treatment: TreatmentRecord;
}) => void;

export type AcceptedRefund = {
  outcome: "accepted";
  provider_call_id: string;
  transaction: RefundTransaction;
  event: PrimaryEvent;
  treatment: TreatmentRecord;
};

export type RejectedRefund = {
  outcome: "rejected";
  provider_call_id: string;
  reasons: readonly string[];
  event?: PrimaryEvent;
};

export type FailedRefund = {
  outcome: "failed";
  provider_call_id: string;
  reasons: readonly string[];
};

export type ProcessRefundResult = AcceptedRefund | RejectedRefund | FailedRefund;

export type LedgerPage = {
  ok: true;
  complete: boolean;
  transactions: readonly RefundTransaction[];
  next_cursor?: string;
};

export type TreatmentRead = {
  ok: true;
  treatment: TreatmentRecord;
};

export type DeniedRead = {
  ok: false;
  reasons: readonly string[];
};

export type SeededPayment = {
  trial_id: string;
  payment: PaymentRecord;
};
