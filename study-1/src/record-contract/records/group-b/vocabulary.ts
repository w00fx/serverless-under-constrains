// Closed value vocabularies of catalogue group B (design §6.2 rows 19-65 plus the addendum §2
// warm-up records). Each tuple is the single TypeScript source of an enum that a group-B JSON
// Schema states literally; the group-B contract tests assert that every schema enum equals its
// tuple, so the runtime list, the derived union type and the schema cannot drift apart.
//
// Casing follows BR-RUA-033: domain and lifecycle values are UPPERCASE; verdict, validity and
// operational status values are lowercase (design §6.1 "Casing").

/** Journal sources that write caller events (design §5.3 `EventSource`). */
export const CALLER_EVENT_SOURCES = ['conventional_caller', 'durable_caller', 'probe_caller'] as const;
export type CallerEventSource = (typeof CALLER_EVENT_SOURCES)[number];

/** The caller identity a provider call declares (design §5.3 `AttemptInput.caller_id`, D-09). */
export const CALLER_IDS = ['conventional', 'durable', 'probe'] as const;
export type CallerId = (typeof CALLER_IDS)[number];

/** BR-RUA-021 attempt outcomes. */
export const ATTEMPT_OUTCOMES = ['SUCCEEDED', 'REJECTED', 'TIMED_OUT', 'FAILED'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

/** BR-RUA-021 dispatch states. */
export const DISPATCH_STATES = ['NOT_DISPATCHED', 'DISPATCHED', 'UNKNOWN'] as const;
export type DispatchState = (typeof DISPATCH_STATES)[number];

/** BR-RUA-022 request processing states. */
export const PROCESSING_STATES = ['NOT_STARTED', 'RUNNING', 'FINISHED'] as const;
export type ProcessingState = (typeof PROCESSING_STATES)[number];

/** BR-RUA-022 request terminal reasons. */
export const PROCESSING_TERMINAL_REASONS = [
  'SUCCEEDED',
  'RETRIES_EXHAUSTED',
  'MESSAGE_REJECTED',
  'PROVIDER_REJECTED',
  'INTERRUPTED',
  'SAFETY_DEADLINE',
] as const;
export type ProcessingTerminalReason = (typeof PROCESSING_TERMINAL_REASONS)[number];

/** BR-RUA-022 effect-knowledge states. */
export const EFFECT_KNOWLEDGE_STATES = [
  'NOT_ATTEMPTED',
  'NO_EFFECT_CONFIRMED',
  'ONE_EFFECT_CONFIRMED',
  'MULTIPLE_EFFECTS_CONFIRMED',
  'UNKNOWN',
] as const;
export type EffectKnowledge = (typeof EFFECT_KNOWLEDGE_STATES)[number];

/**
 * Failure codes that prove an attempt never reached transport (design §5.3 C2, and C3 when the
 * dispatch transition was definitively not applied, so the conditional `PRE_DISPATCH →
 * NOT_DISPATCHED` transition is still possible).
 */
export const PRE_DISPATCH_FAILURE_CODES = ['CALL_BUILD_FAILED', 'DISPATCH_TRANSITION_REJECTED'] as const;
export type PreDispatchFailureCode = (typeof PRE_DISPATCH_FAILURE_CODES)[number];

/** Every `FAILED` outcome code a provider-client attempt can record (design §5.3 C1-C6, §9.9). */
export const ATTEMPT_FAILURE_CODES = [
  ...PRE_DISPATCH_FAILURE_CODES,
  'DISPATCH_TRANSITION_CONDITION_FAILED',
  'DISPATCH_TRANSITION_AMBIGUOUS',
  'FUNCTION_ERROR',
  'VERSION_MISMATCH',
  'MALFORMED_RESPONSE',
  'ABORTED_WITHOUT_DEADLINE',
  'TRANSPORT_ERROR',
  'TIMEOUT_RECORD_NOT_DURABLE',
] as const;
export type AttemptFailureCode = (typeof ATTEMPT_FAILURE_CODES)[number];

/** BR-RUA-023 in-process arbiter claimants. */
export const ARBITER_WINNERS = ['TIMER', 'TRANSPORT'] as const;
export type ArbiterWinner = (typeof ARBITER_WINNERS)[number];

/** D-26: how a transport settled after the timer already won (the payload is never parsed). */
export const TRANSPORT_SETTLEMENT_KINDS = ['aborted', 'resolved', 'rejected'] as const;
export type TransportSettlementKind = (typeof TRANSPORT_SETTLEMENT_KINDS)[number];

/** BR-RUA-036 consumer-side rejection reasons (design §5.3 `ConsumerValidation`). */
export const TRIAL_MESSAGE_REJECTION_REASONS = [
  'SCHEMA_INVALID',
  'CORRELATION_MISSING',
  'EXECUTION_IDENTITY_MISMATCH',
  'TRIAL_MANIFEST_DIGEST_MISMATCH',
  'NO_ACTIVE_TRIAL',
] as const;
export type TrialMessageRejectionReason = (typeof TRIAL_MESSAGE_REJECTION_REASONS)[number];

/** BR-RUA-018 provider rejection reasons, in the acceptance order of design §9.10. */
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

/** BR-RUA-025 treatment states, including the safety-release terminal. */
export const TREATMENT_STATES = [
  'ARMED',
  'COMMITTED_WAITING',
  'TIMEOUT_SIGNALLED',
  'TIMEOUT_OBSERVED',
  'RESPONSE_RELEASED',
  'SAFETY_RELEASED',
] as const;
export type TreatmentState = (typeof TREATMENT_STATES)[number];

/** The non-terminal waits a safety release can leave (BR-RUA-025 "from any nonterminal wait"). */
export const NONTERMINAL_TREATMENT_STATES = [
  'ARMED',
  'COMMITTED_WAITING',
  'TIMEOUT_SIGNALLED',
  'TIMEOUT_OBSERVED',
] as const;
export type NonterminalTreatmentState = (typeof NONTERMINAL_TREATMENT_STATES)[number];

/** States in which a signal already exists (design §9.11 duplicate and conflict rows). */
export const SIGNALLED_TREATMENT_STATES = ['TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED', 'RESPONSE_RELEASED'] as const;
export type SignalledTreatmentState = (typeof SIGNALLED_TREATMENT_STATES)[number];

/** Why a treatment barrier was released without an observed signal (design §6.2 row 37). */
export const SAFETY_RELEASE_CAUSES = ['SAFETY_DEADLINE', 'CLEANUP_REQUEST'] as const;
export type SafetyReleaseCause = (typeof SAFETY_RELEASE_CAUSES)[number];

/** Controller rejections of a caller timeout (design §9.11). */
export const CALLER_TIMEOUT_REJECTION_REASONS = [
  'BEFORE_COMMIT',
  'NOT_TARGETED',
  'INVALID_EVENT',
  'CONTROL_TRIAL',
] as const;
export type CallerTimeoutRejectionReason = (typeof CALLER_TIMEOUT_REJECTION_REASONS)[number];

/** Execution phases P1-P9 of the runner (design §10.2). */
export const EXECUTION_PHASES = [
  'LEASE_ACQUISITION',
  'PROVISIONING',
  'READINESS',
  'TRIALS',
  'PROBE_FREEZE',
  'LATE_MONITORING',
  'CLEANUP',
  'LEASE_FINALIZATION',
  'SUMMARY',
] as const;
export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];

/**
 * Progress of a runner phase or a cleanup step: an operational status, so lowercase (design §6.1
 * "every operational status is lowercase"), spelled like BR-RUA-051 `cleanup_status`.
 */
export const STEP_STATUSES = ['started', 'succeeded', 'failed', 'skipped'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

/** Provisioning journal events (design §6.2 row 46, §9.8 D1-D4). */
export const PROVISIONING_EVENTS = [
  'DEPLOY_COPY_VERIFIED',
  'DEPLOY_STARTED',
  'DEPLOY_SUCCEEDED',
  'DEPLOY_FAILED',
  'PACKAGE_ASSEMBLY_REVERIFIED',
  'STACK_ID_RECORDED',
] as const;
export type ProvisioningEvent = (typeof PROVISIONING_EVENTS)[number];

/** Tables whose trial partition is asserted absent before a trial (BR-RUA-019, design §9.3). */
export const TRIAL_PARTITION_TABLE_ROLES = ['ledger', 'experiment_journal', 'caller_journal', 'control'] as const;
export type TrialPartitionTableRole = (typeof TRIAL_PARTITION_TABLE_ROLES)[number];

/** BR-RUA-032 settlement assessment statuses (design §5.3 `SettlementAssessment`). */
export const SETTLEMENT_STATUSES = ['established', 'not_established'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** Causes that restart the settlement window (design §5.3 `SettlementRestartCause`). */
export const SETTLEMENT_RESTART_CAUSES = [
  'SOURCE_VISIBLE',
  'SOURCE_IN_FLIGHT',
  'SOURCE_DELAYED',
  'NEW_CORRELATED_DLQ_MESSAGE',
  'UNCAPTURED_DLQ_MESSAGE',
  'CORRELATED_JOURNAL_ACTIVITY',
  'LEDGER_ACTIVITY',
  'PROVIDER_ACTIVE',
  'PROCESSING_NOT_TERMINAL',
  'INNER_EXECUTION_ACTIVE',
  'TREATMENT_NOT_TERMINAL',
  'QUEUE_UNAVAILABLE',
  'PRE_FREEZE_ACTIVITY',
] as const;
export type SettlementRestartCause = (typeof SETTLEMENT_RESTART_CAUSES)[number];

/** Settlement sample phases (D-32 pre-freeze recheck). */
export const SETTLEMENT_SAMPLE_PHASES = ['observation', 'pre_freeze_recheck'] as const;
export type SettlementSamplePhase = (typeof SETTLEMENT_SAMPLE_PHASES)[number];

/** Markers a settlement sample uses instead of a value (design §5.3 `SettlementSample`). */
export const NOT_APPLICABLE = 'not_applicable';
export const QUEUE_COUNTER_MARKERS = [NOT_APPLICABLE, 'unavailable'] as const;
export type QueueCounterMarker = (typeof QUEUE_COUNTER_MARKERS)[number];

/** Trial interruption causes (design §6.2 row 53, §10.2). */
export const INTERRUPTION_CAUSES = ['LEASE_LOST', 'OPERATOR_ABORT', 'SAFETY_DEADLINE', 'INTERRUPTED'] as const;
export type InterruptionCause = (typeof INTERRUPTION_CAUSES)[number];

/** BR-RUA-046 safety boundaries (design §8.17). */
export const SAFETY_BOUNDARIES = [
  'ACCOUNT_ALLOWLIST',
  'REGION',
  'REQUIRED_CAPABILITIES',
  'OWNERSHIP_STRATEGY',
  'ESTIMATED_COST',
  'CONFLICTING_LEASE',
  'ACTIVE_TIME',
  'TOTAL_TIME',
  'CLEANUP_TERMINAL',
  'BILLED_COST',
] as const;
export type SafetyBoundary = (typeof SAFETY_BOUNDARIES)[number];

/** BR-RUA-046 safety status values, used per check. */
export const SAFETY_RESULTS = ['within_limits', 'breached', 'unverified'] as const;
export type SafetyResult = (typeof SAFETY_RESULTS)[number];

/** BR-RUA-045 lease journal events (design §10.3 state machine). */
export const LEASE_EVENTS = [
  'ACQUIRED',
  'ACQUISITION_FAILED',
  'HEARTBEAT_CONFIRMED',
  'HEARTBEAT_FAILED',
  'RECOVERED',
  'LOST_OWNERSHIP_MISMATCH',
  'LOST_STALE',
  'RELEASED',
  'RELEASE_FAILED',
  'RECOVERY_REQUIRED',
  'STATE_UNVERIFIED',
] as const;
export type LeaseEvent = (typeof LEASE_EVENTS)[number];

/** Lease health after an observation (design §5.3 `LeaseHealth`). */
export const LEASE_HEALTH_STATES = ['CONFIRMED', 'UNCERTAIN', 'LOST_OWNERSHIP_MISMATCH', 'LOST_STALE'] as const;
export type LeaseHealth = (typeof LEASE_HEALTH_STATES)[number];

/** BR-RUA-048 normal and BR-RUA-049 emergency cleanup. */
export const CLEANUP_MODES = ['NORMAL', 'EMERGENCY'] as const;
export type CleanupMode = (typeof CLEANUP_MODES)[number];

/** BR-RUA-050 ownership decisions (design §5.3 `OwnershipDecision` and its bases). */
export const OWNERSHIP_BASES = [
  'recorded_stack',
  'resource_manifest_and_tags',
  'tags_name_type_created_after_freeze',
  'ambiguous',
  'excluded_baseline',
] as const;
export type OwnershipBasis = (typeof OWNERSHIP_BASES)[number];

/** Which queue of a variant an observation reads. */
export const QUEUE_ROLES = ['source', 'dlq'] as const;
export type QueueRole = (typeof QUEUE_ROLES)[number];

/** Whether an operational read succeeded (approximate counters may be unavailable). */
export const READ_STATUSES = ['ok', 'unavailable'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

/** A treatment-item read: present, proven absent, or not readable. */
export const TREATMENT_READ_STATUSES = ['ok', 'absent', 'unavailable'] as const;
export type TreatmentReadStatus = (typeof TREATMENT_READ_STATUSES)[number];

/** Durable execution statuses of the Lambda control plane (durable-functions research §API). */
export const DURABLE_EXECUTION_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'STOPPED'] as const;
export type DurableExecutionStatus = (typeof DURABLE_EXECUTION_STATUSES)[number];

/** BR-RUA-037 diagnostic telemetry availability (AC-RUA-054). */
export const TELEMETRY_AVAILABILITIES = ['available', 'unavailable'] as const;
export type TelemetryAvailability = (typeof TELEMETRY_AVAILABILITIES)[number];

/** BR-RUA-009 ledger transaction status; the ledger stores successful transactions only. */
export const LEDGER_TRANSACTION_STATUSES = ['SUCCEEDED'] as const;
export type LedgerTransactionStatus = (typeof LEDGER_TRANSACTION_STATUSES)[number];
