export type ValidationSuccess<T> = {
  ok: true;
  value: T;
};

export type ValidationFailure = {
  ok: false;
  reasons: readonly string[];
};

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export type PaymentRecord = {
  schema_version: 1;
  record_type: "payment";
  payment_id: string;
  captured_amount_minor: number;
  currency: "BRL";
};

export type ApprovedDecisionRecord = {
  schema_version: 1;
  record_type: "approved_decision";
  refund_request_id: string;
  payment_id: string;
  decision: "APPROVED";
  approved_amount_minor: number;
  currency: "BRL";
};

export type EvidenceRef = {
  artifact_path: string;
  artifact_sha256: string;
  event_id?: string;
  json_pointer?: string;
  package_index_sha256?: string;
};

export type PrimaryEvent = {
  schema_version: 1;
  record_type: string;
  event_id: string;
  occurred_at: string;
  source: string;
  source_instance_id: string;
  source_sequence: number;
  trial_manifest_sha256: string;
  run_id?: string;
  transport_probe_id?: string;
  variant_validation_id?: string;
  causation_event_ids?: readonly string[];
  [correlation: string]: unknown;
};

export type EventSequenceReport = {
  equivalent_duplicates: number;
  content_conflicts: readonly string[];
  sequence_conflicts: readonly string[];
  gaps: readonly string[];
  missing_causation: readonly string[];
};
