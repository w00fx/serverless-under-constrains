export {
  ALLOWED_REGION,
  EXPECTED_COORDINATION_SCHEMA_VERSION,
} from "../coordination/identity.ts";

export const SCHEMA_VERSION = 1;
export const ALLOWED_CURRENCY = "BRL";
export const MAX_SAFE_AMOUNT_MINOR = 9007199254740991;
export const PROBE_ACTIVE_TIME_SECONDS = 600;
export const PROBE_RESERVED_CLEANUP_SECONDS = 600;
export const PROBE_TOTAL_TARGET_SECONDS = 1200;
export const PROBE_STABILIZATION_INTERVAL_SECONDS = 120;
export const PROBE_USAGE_CEILING_USD_MINOR = 100;
export const PROVIDER_CLIENT_DEADLINE_SECONDS = 3;
export const PROVIDER_SAFETY_RELEASE_SECONDS = 15;
export const PROVIDER_EXECUTION_TIMEOUT_SECONDS = 30;
export const TREATMENT_STATE_POLLING_INTERVAL_MILLISECONDS = 250;
export const RETRY_JITTER = "NONE";
export const FIDELITY_BASIS = "causal_plus_cross_source_clock_assumption";
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export type RejectionCategory =
  | "configuration"
  | "source"
  | "tool"
  | "account"
  | "region"
  | "coordination"
  | "synthesis";

export type RejectionReason = {
  code: string;
  category: RejectionCategory;
  expected?: unknown;
  observed?: unknown;
};

export type PaymentInput = {
  schema_version: unknown;
  record_type: unknown;
  payment_id: unknown;
  captured_amount_minor: unknown;
  currency: unknown;
};

export type ApprovedDecisionInput = {
  schema_version: unknown;
  record_type: unknown;
  refund_request_id: unknown;
  payment_id: unknown;
  decision: unknown;
  approved_amount_minor: unknown;
  currency: unknown;
};

export type EnvironmentInput = {
  allowlisted_account_id: unknown;
  coordination_resource_arn: unknown;
  coordination_stack_identity: unknown;
  expected_coordination_schema_version: unknown;
  [key: string]: unknown;
};

export type SourceObservation = {
  head_revision: unknown;
  lockfile_present: unknown;
  lockfile_tracked: unknown;
};

export type ToolObservation = {
  node_version: unknown;
};

export type SynthesisFileInput = {
  path: unknown;
  kind: unknown;
};

export type SynthesisInput = {
  files: unknown;
  [key: string]: unknown;
};

export type SafetyInput = {
  active_probe_time_seconds: unknown;
  reserved_cleanup_seconds: unknown;
  total_target_seconds: unknown;
  stabilization_interval_seconds: unknown;
  estimated_attributable_usage_usd_minor: unknown;
  ownership_strategy: unknown;
};

export type ProbeAttemptProposal = {
  payment: PaymentInput;
  approved_decision: ApprovedDecisionInput;
  environment: EnvironmentInput;
  resolved_caller_account_id: unknown;
  region: unknown;
  source: SourceObservation;
  tools: ToolObservation;
  synthesis: SynthesisInput | undefined | null;
  safety: SafetyInput;
};

export type CloudMutationRequest = {
  kind: "provision" | "lease_acquire" | "deploy" | "cleanup";
  probe_attempt_id: string;
};

export interface CloudMutationAdapter {
  mutate(request: CloudMutationRequest): Promise<void> | void;
}

export type ProbeAdmissionDependencies = {
  evidenceRoot: string;
  mutation: CloudMutationAdapter;
  now?: () => Date;
  createId?: () => string;
};

export type ProbeAdmissionResult =
  | { status: "admitted"; probe_attempt_id: string }
  | {
      status: "rejected";
      probe_attempt_id: string;
      rejection_path: string;
      journal_path: string;
      reasons: RejectionReason[];
    };

export type ProbeFreezeResult =
  | {
      status: "frozen";
      transport_probe_id: string;
      probe_attempt_id: string;
      manifest_path: string;
      manifest_sha256: string;
    }
  | Extract<ProbeAdmissionResult, { status: "rejected" }>;
