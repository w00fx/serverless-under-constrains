export const SCHEMA_VERSION = 1;
export const ALLOWED_CURRENCY = "BRL";
export const MAX_SAFE_AMOUNT_MINOR = 9007199254740991;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const EXECUTION_IDENTITY_KEYS = [
  "run_id",
  "transport_probe_id",
  "variant_validation_id",
] as const;

export const EVIDENCE_REF_ALIASES = [
  "evidence_references",
  "evidence",
  "references",
] as const;

export const EVIDENCE_REF_KEYS = [
  "artifact_path",
  "artifact_sha256",
  "event_id",
  "json_pointer",
  "package_index_sha256",
] as const;

export type ExecutionIdentityKey = (typeof EXECUTION_IDENTITY_KEYS)[number];

export type RejectionReason = {
  code: string;
  field?: string;
  expected?: unknown;
  observed?: unknown;
};

export type ValidationOk<T> = {
  ok: true;
  value: T;
};

export type ValidationErr = {
  ok: false;
  reasons: RejectionReason[];
};

export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

export type SequenceClassification = {
  ok: true;
  duplicate_event_ids: Array<{ event_id: string; count: number }>;
};

export type Payment = {
  schema_version: 1;
  record_type: "payment";
  payment_id: string;
  captured_amount_minor: number;
  currency: "BRL";
};

export type ApprovedDecision = {
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

export type CreateEvidenceRefsOptions = {
  requirePackageIndex?: boolean;
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
  causation_event_ids?: string[];
  run_id?: string;
  transport_probe_id?: string;
  variant_validation_id?: string;
  [key: string]: unknown;
};
