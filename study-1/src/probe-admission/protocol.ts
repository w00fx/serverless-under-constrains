import {
  FIDELITY_BASIS,
  PROVIDER_CLIENT_DEADLINE_SECONDS,
  PROVIDER_EXECUTION_TIMEOUT_SECONDS,
  PROVIDER_SAFETY_RELEASE_SECONDS,
  RETRY_JITTER,
  SCHEMA_VERSION,
  TREATMENT_STATE_POLLING_INTERVAL_MILLISECONDS,
} from "./types.ts";

export const CLOCK_ASSUMPTION_CA1 = {
  schema_version: SCHEMA_VERSION,
  record_type: "clock_assumption",
  assumption_id: "CA-1",
  assumption_type: "clock_alignment",
  scope: "same-account, same-Region AWS Lambda execution environments",
  statement:
    "UTC wall-clock timestamps preserve the ordering of the provider commit and caller timer events for this PoC.",
  status: "declared_not_service_guaranteed",
} as const;

export const PROBE_TIMING = {
  provider_client_deadline_seconds: PROVIDER_CLIENT_DEADLINE_SECONDS,
  provider_safety_release_seconds: PROVIDER_SAFETY_RELEASE_SECONDS,
  provider_execution_timeout_seconds: PROVIDER_EXECUTION_TIMEOUT_SECONDS,
  treatment_state_polling_interval_milliseconds:
    TREATMENT_STATE_POLLING_INTERVAL_MILLISECONDS,
  retry_jitter: RETRY_JITTER,
} as const;

export const TQ_DEFINITIONS = [
  {
    schema_version: SCHEMA_VERSION,
    record_type: "transport_qualification_condition",
    condition_id: "TQ-1",
    title: "Commit Before Timer",
    statement:
      "The provider transaction must be durably committed before the caller timer wins.",
    ordering_basis: "cross_source_wall_clock",
    clock_assumption_refs: ["CA-1"],
  },
  {
    schema_version: SCHEMA_VERSION,
    record_type: "transport_qualification_condition",
    condition_id: "TQ-2",
    title: "Application Timeout",
    statement:
      "The application-owned timer must win after at least three seconds of source-local monotonic elapsed time while the transport promise remains unsettled, abort transport, and cause the durable caller_timeout_recorded event.",
    clock_assumption_refs: [],
  },
  {
    schema_version: SCHEMA_VERSION,
    record_type: "transport_qualification_condition",
    condition_id: "TQ-3",
    title: "Continued Provider Execution",
    statement: "The provider must continue executing after the caller aborts.",
    clock_assumption_refs: [],
  },
  {
    schema_version: SCHEMA_VERSION,
    record_type: "transport_qualification_condition",
    condition_id: "TQ-4",
    title: "Causal Join and Observation",
    statement:
      "The controller signal must be immediately caused by both provider commit and caller timeout, and the provider must subsequently observe that signal.",
    clock_assumption_refs: [],
  },
  {
    schema_version: SCHEMA_VERSION,
    record_type: "transport_qualification_condition",
    condition_id: "TQ-5",
    title: "Controlled Release",
    statement:
      "The provider must release only after timeout observation, and no safety release may occur.",
    clock_assumption_refs: [],
  },
  {
    schema_version: SCHEMA_VERSION,
    record_type: "transport_qualification_condition",
    condition_id: "TQ-6",
    title: "No Caller-Observed Success",
    statement:
      "The caller must never observe a successful provider response for the targeted attempt.",
    clock_assumption_refs: [],
  },
] as const;

export const EXPECTED_TQ_CONDITION_IDS = TQ_DEFINITIONS.map(
  (definition) => definition.condition_id,
);

export const EXPECTED_FIDELITY_BASIS = FIDELITY_BASIS;
