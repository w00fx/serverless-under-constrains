// Closed value vocabularies of catalogue group C (design §6.2 rows 66-88). Each tuple is the
// single TypeScript source of an enum that a group-C JSON Schema states literally; the group-C
// contract tests assert that every schema enum equals its tuple, so the runtime list, the
// derived union type and the schema cannot drift apart. Vocabularies group B already owns
// (dispatch states, terminal reasons, safety boundaries, ...) are imported from there, never
// restated.
//
// Casing follows BR-RUA-033: domain and lifecycle values are UPPERCASE; verdict, validity,
// eligibility and operational status values are lowercase (design §6.1 "Casing").

/** BR-RUA-006 preservation verdict, BR-RUA-027 probe verdict. */
export const PRESERVATION_VERDICTS = ['pass', 'fail', 'indeterminate'] as const;
export type PreservationVerdict = (typeof PRESERVATION_VERDICTS)[number];

/** BR-RUA-029 aggregate trial validity; BR-RUA-027 probe validity; BR-RUA-038 validation validity. */
export const TRIAL_VALIDITIES = ['valid', 'invalid', 'indeterminate'] as const;
export type TrialValidity = (typeof TRIAL_VALIDITIES)[number];

/** A gate value that is always applicable (CTR-RUA-003 `evidence_integrity`, CTR-RUA-002 status). */
export const APPLICABLE_GATE_VALUES = ['verified', 'invalid', 'unverified'] as const;
export type ApplicableGateValue = (typeof APPLICABLE_GATE_VALUES)[number];

/** The validity gates of design §8.3, in G1-G8 order with G4 split into G4a and G4b. */
export const GATE_IDS = [
  'independent_oracle',
  'traceability',
  'identity_integrity',
  'control_integrity',
  'treatment_fidelity',
  'ledger_access',
  'settlement',
  'rule_evidence',
  'evidence_integrity',
] as const;
export type GateId = (typeof GATE_IDS)[number];

/** The ten `rule_results[]` entries of an oracle result, in their fixed order (design §6.3, D-04). */
export const ORACLE_RULE_IDS = [
  'BR-RUA-001',
  'BR-RUA-002',
  'BR-RUA-003',
  'BR-RUA-004',
  'BR-RUA-005',
  'BR-RUA-007',
  'BR-RUA-008',
  'BR-RUA-009',
  'INV-RUA-001',
  'BR-RUA-025',
] as const;
export type OracleRuleId = (typeof ORACLE_RULE_IDS)[number];

/** The six treatment conditions BR-RUA-010 to BR-RUA-015, in their fixed order (design §8.10). */
export const CONDITION_IDS = [
  'BR-RUA-010',
  'BR-RUA-011',
  'BR-RUA-012',
  'BR-RUA-013',
  'BR-RUA-014',
  'BR-RUA-015',
] as const;
export type ConditionId = (typeof CONDITION_IDS)[number];

/** BR-RUA-025 mandatory fidelity basis. The PoC never emits `causal` (D-05), the schema admits it. */
export const FIDELITY_BASES = ['causal_plus_cross_source_clock_assumption', 'causal', 'not_applicable'] as const;
export type FidelityBasis = (typeof FIDELITY_BASES)[number];

/** The declared clock assumptions a result may cite (CA-1). */
export const CLOCK_ASSUMPTION_IDS = ['CA-1'] as const;
export type ClockAssumptionId = (typeof CLOCK_ASSUMPTION_IDS)[number];

/** CTR-RUA-003: the probe orders commit and timer by cross-source wall clock under CA-1. */
export const ORDERING_BASES = ['cross_source_wall_clock'] as const;
export type OrderingBasis = (typeof ORDERING_BASES)[number];

/** The outcome classes of an attempt (design §5.3 `OutcomeClass`, BR-RUA-022 table columns). */
export const OUTCOME_CLASSES = ['PRE_DISPATCH_FAILURE', 'REJECTION', 'SUCCESS', 'AMBIGUOUS'] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** BR-RUA-034 ingestion findings a condition result may be affected by (design §5.3). */
export const INGESTION_FINDING_CODES = [
  'EQUIVALENT_DUPLICATE_COLLAPSED',
  'CONFLICTING_EVENT_CONTENT',
  'CONFLICTING_SOURCE_SEQUENCE',
  'SOURCE_SEQUENCE_GAP',
  'CAUSAL_PREDECESSOR_MISSING',
  'DUPLICATE_LEDGER_TRANSACTION_ID',
  'LEDGER_PAGINATION_INCOMPLETE',
  'CORE_FILE_DIGEST_MISMATCH',
  'ARTIFACT_MISSING',
  'ARTIFACT_UNPARSEABLE',
  'RECORD_SCHEMA_INVALID',
  'CORRELATION_MISSING',
  'LEDGER_LARGER_THAN_EXPECTED',
] as const;
export type IngestionFindingCode = (typeof INGESTION_FINDING_CODES)[number];

/** How the provider handled one received call in the attempt projection (design §8.9). */
export const PROVIDER_CALL_DISPOSITIONS = ['ACCEPTED', 'REJECTED', 'UNRESOLVED'] as const;
export type ProviderCallDisposition = (typeof PROVIDER_CALL_DISPOSITIONS)[number];

/** CTR-RUA-002 run summary execution status. */
export const EXECUTION_STATUSES = ['completed', 'incomplete'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Per-trial execution status of a summary entry (design §6.3). */
export const TRIAL_EXECUTION_STATUSES = ['completed', 'incomplete', 'not_started'] as const;
export type TrialExecutionStatus = (typeof TRIAL_EXECUTION_STATUSES)[number];

/** CTR-RUA-002 canonical run terminal reasons. */
export const RUN_TERMINAL_REASONS = [
  'COMPLETED',
  'LEASE_ACQUISITION_FAILED',
  'LEASE_LOST',
  'PROVISIONING_FAILED',
  'TRIAL_INCOMPLETE',
  'SAFETY_DEADLINE',
  'OPERATOR_ABORT',
  'INTERRUPTED',
  'CLEANUP_INCOMPLETE',
  'LEAK_AUDIT_NOT_CLEAN',
  'EVIDENCE_FINALIZATION_FAILED',
] as const;
export type RunTerminalReason = (typeof RUN_TERMINAL_REASONS)[number];

/** CTR-RUA-003 probe terminal reasons. */
export const PROBE_TERMINAL_REASONS = [
  'COMPLETED',
  'LEASE_ACQUISITION_FAILED',
  'LEASE_LOST',
  'PROVISIONING_FAILED',
  'PROBE_INCOMPLETE',
  'SAFETY_DEADLINE',
  'OPERATOR_ABORT',
  'INTERRUPTED',
  'CLEANUP_INCOMPLETE',
  'LEAK_AUDIT_NOT_CLEAN',
  'EVIDENCE_FINALIZATION_FAILED',
] as const;
export type ProbeTerminalReason = (typeof PROBE_TERMINAL_REASONS)[number];

/**
 * Probe terminal reasons that arise only after phase P5 froze the probe result (design §10.2):
 * the lifecycle completed, or normal cleanup (P7) or its leak audit did not end clean. A summary
 * with one of them carries the probe-result digest (CTR-RUA-003).
 */
export const POST_FREEZE_PROBE_TERMINAL_REASONS = [
  'COMPLETED',
  'CLEANUP_INCOMPLETE',
  'LEAK_AUDIT_NOT_CLEAN',
] as const satisfies readonly ProbeTerminalReason[];
export type PostFreezeProbeTerminalReason = (typeof POST_FREEZE_PROBE_TERMINAL_REASONS)[number];

/** BR-RUA-038 canonical validation terminal reasons. */
export const VALIDATION_TERMINAL_REASONS = [
  'COMPLETED',
  'LEASE_ACQUISITION_FAILED',
  'LEASE_LOST',
  'LEASE_RELEASE_FAILED',
  'LEASE_STATE_UNVERIFIED',
  'PROVISIONING_FAILED',
  'VALIDATION_INCOMPLETE',
  'SAFETY_DEADLINE',
  'SAFETY_LIMIT_EXCEEDED',
  'OPERATOR_ABORT',
  'INTERRUPTED',
  'CLEANUP_INCOMPLETE',
  'LEAK_AUDIT_NOT_CLEAN',
  'EVIDENCE_FINALIZATION_FAILED',
] as const;
export type ValidationTerminalReason = (typeof VALIDATION_TERMINAL_REASONS)[number];

/** BR-RUA-038 implementation validation status (declared and effective). */
export const IMPLEMENTATION_VALIDATION_STATUSES = ['verified', 'failed', 'indeterminate'] as const;
export type ImplementationValidationStatus = (typeof IMPLEMENTATION_VALIDATION_STATUSES)[number];

/** BR-RUA-007 / BR-RUA-031 comparison eligibility; BR-RUA-044 package eligibility. */
export const ELIGIBILITIES = ['eligible', 'ineligible'] as const;
export type Eligibility = (typeof ELIGIBILITIES)[number];

/** BR-RUA-051 cleanup status. The verifier, not the schema, refuses a non-terminal final value. */
export const CLEANUP_STATUSES = ['not_started', 'running', 'succeeded', 'partial', 'failed'] as const;
export type CleanupStatus = (typeof CLEANUP_STATUSES)[number];

/** BR-RUA-051 leak-audit status. */
export const LEAK_AUDIT_STATUSES = ['clean', 'leaks_detected', 'inconclusive'] as const;
export type LeakAuditStatus = (typeof LEAK_AUDIT_STATUSES)[number];

/** BR-RUA-045 final lease status. */
export const LEASE_STATUSES = ['released', 'recovery_required', 'unverified'] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/** CTR-RUA-004 effective cleanup status: a terminal status, or `unverified` when not establishable. */
export const EFFECTIVE_CLEANUP_STATUSES = ['succeeded', 'partial', 'failed', 'unverified'] as const;
export type EffectiveCleanupStatus = (typeof EFFECTIVE_CLEANUP_STATUSES)[number];

/** CTR-RUA-004 effective leak-audit status. */
export const EFFECTIVE_LEAK_AUDIT_STATUSES = ['clean', 'leaks_detected', 'inconclusive', 'unverified'] as const;
export type EffectiveLeakAuditStatus = (typeof EFFECTIVE_LEAK_AUDIT_STATUSES)[number];

/** Operational recovery repairs only these terminal cleanup values (BR-RUA-038). */
export const TERMINAL_CLEANUP_STATUSES = ['succeeded', 'partial', 'failed'] as const;
export type TerminalCleanupStatus = (typeof TERMINAL_CLEANUP_STATUSES)[number];

/** BR-RUA-043 late-evidence assessment. */
export const LATE_EVIDENCE_STATUSES = ['none', 'consistent', 'contradictory', 'unverified'] as const;
export type LateEvidenceStatus = (typeof LATE_EVIDENCE_STATUSES)[number];

/** How late monitoring ended (design §5.3 `assessLateEvidence`, D-16). */
export const LATE_MONITORING_OUTCOMES = ['complete', 'shortened', 'skipped', 'failed'] as const;
export type LateMonitoringOutcome = (typeof LATE_MONITORING_OUTCOMES)[number];

/** Where a late record was observed after freeze (BR-RUA-043). */
export const LATE_EVIDENCE_SOURCES = [
  'CALLER_JOURNAL',
  'PROVIDER_JOURNAL',
  'CONTROLLER_JOURNAL',
  'RUNNER_JOURNAL',
  'LEDGER',
  'SOURCE_QUEUE',
  'DLQ',
  'DURABLE_EXECUTION_METADATA',
] as const;
export type LateEvidenceSource = (typeof LATE_EVIDENCE_SOURCES)[number];

/** The scope an evidence index freezes (design §7 index scopes). */
export const EVIDENCE_INDEX_SCOPES = ['TRIAL', 'PROBE'] as const;
export type EvidenceIndexScope = (typeof EVIDENCE_INDEX_SCOPES)[number];

/** Whether an indexed file is primary evidence or derived from it (BR-RUA-037). */
export const ARTIFACT_DERIVATIONS = ['primary', 'derived'] as const;
export type ArtifactDerivation = (typeof ARTIFACT_DERIVATIONS)[number];

/** The class of every file an evidence, package or amendment index may list (design §7 layout). */
export const ARTIFACT_CLASSES = [
  'environment_input',
  'execution_manifest',
  'preflight_journal',
  'source_provenance',
  'oracle_revision_check',
  'transport_scope_snapshot',
  'schema_file',
  'deployment_assembly_file',
  'deployment_assembly_inventory',
  'coordination_journal',
  'coordination_prefix_checkpoint',
  'provisioning_journal',
  'resource_manifest',
  'runner_journal',
  // Addendum §2.2 and D-10 readiness evidence, each export of one execution-level partition:
  // the provider's `<execution_id>#warmup` partition, the runner-inserted
  // `caller_timeout_recorded` in the caller journal's `<execution_id>#canary` partition, and the
  // controller's acknowledgement in its `<execution_id>#canary` partition. Included in the
  // package, never an input to a monetary rule, gate or treatment condition.
  'provider_warmup_journal',
  'caller_canary_journal',
  'controller_canary_journal',
  // Owner amendment A-09 and decisions 58/65: the runner's execution-level configuration item
  // (`<execution_id>#execution`/`config` in the control table), exported by the evidence collector.
  // Supplementary like the readiness journals, never an execution-scope input (A-13).
  'provider_execution_configuration',
  'trial_manifest',
  'payment',
  'approved_decision',
  'published_message',
  'provider_trial_configuration',
  'treatment_state_snapshot',
  'trial_registration',
  'caller_journal',
  'provider_journal',
  'controller_journal',
  'ledger_snapshot',
  'source_observations',
  'dlq_observations',
  'dlq_snapshot',
  'settlement_samples',
  'durable_execution_metadata',
  'telemetry_availability',
  'attempt_projection',
  'oracle_result',
  'transport_probe_result',
  'evidence_index',
  'late_evidence_stream',
  'late_evidence_assessment',
  'pre_cleanup_snapshot',
  'cleanup_journal',
  'cleanup_result',
  'leak_audit_result',
  'comparison_assessment',
  'safety_assessment',
  'run_summary',
  'validation_summary',
  'transport_probe_summary',
  'operational_recovery_record',
  'billing_import',
  'billing_export_file',
] as const;
export type ArtifactClass = (typeof ARTIFACT_CLASSES)[number];

/** BR-RUA-043 amendment kinds (design §6.2 row 84). */
export const AMENDMENT_KINDS = ['LATE_EVIDENCE', 'OPERATIONAL_RECOVERY', 'BILLING', 'REASSESSMENT'] as const;
export type AmendmentKind = (typeof AMENDMENT_KINDS)[number];

/** Package-verification ineligibility codes (design §8.16, D-12). */
export const PACKAGE_INELIGIBILITY_CODES = [
  'INDEX_MISSING',
  'ALTERED_BYTES',
  'UNINDEXED_FILE',
  'UNRESOLVED_REFERENCE',
  'NON_TERMINAL_STATUS',
  'BROKEN_PARENT',
  'SEQUENCE_GAP',
  'CYCLE',
  'UNKNOWN_HEAD',
  'UNSELECTED_DESCENDANT',
  'CONTRADICTORY_CHAIN',
] as const;
export type PackageIneligibilityCode = (typeof PACKAGE_INELIGIBILITY_CODES)[number];

/** BR-RUA-026 probe usability. */
export const PROBE_USABILITIES = ['usable', 'not_usable'] as const;
export type ProbeUsability = (typeof PROBE_USABILITIES)[number];

/** The reason each unmet BR-RUA-026 usability condition adds (design §8.11). */
export const PROBE_UNUSABILITY_CODES = [
  'PROBE_NOT_PASSING',
  'PROBE_INVALID_OR_UNFAITHFUL',
  'EVIDENCE_NOT_VERIFIED',
  'LATE_EVIDENCE_CONTRADICTORY',
  'LATE_EVIDENCE_UNVERIFIED',
  'OPERATIONAL_CLOSURE_NOT_CLEAN',
  'KNOWN_SAFETY_BREACH',
  'PACKAGE_NOT_VERIFIED',
  'NO_TRANSPORT_SCOPE_SNAPSHOT',
] as const;
export type ProbeUnusabilityCode = (typeof PROBE_UNUSABILITY_CODES)[number];

/** BR-RUA-007 equality projections, in their fixed order (design §8.14). */
export const EQUALITY_PROJECTION_IDS = [
  'financial_inputs',
  'control_parameters',
  'treatment_parameters',
  'message_source_protocol',
  'provider_configuration',
  'controller_configuration',
  'caller_timing',
  'observation_window',
] as const;
export type EqualityProjectionId = (typeof EQUALITY_PROJECTION_IDS)[number];

/** BR-RUA-031 / BR-RUA-052 comparison-eligibility conditions, in design §8.14 order. */
export const COMPARISON_CHECK_IDS = [
  'FOUR_ORACLE_RESULTS',
  'ALL_TRIALS_VALID',
  'CONTROLS_VERIFIED',
  'TREATMENTS_VERIFIED',
  'EQUALITY_PASSES',
  'EVIDENCE_INTEGRITY_VERIFIED',
  'LATE_EVIDENCE_ACCEPTABLE',
  'NO_CONTRADICTORY_AMENDMENT',
  'NO_ISOLATION_COMPROMISING_LEAK',
] as const;
export type ComparisonCheckId = (typeof COMPARISON_CHECK_IDS)[number];

/** BR-RUA-054 conditions beyond the six status values, in design §8.14 order. */
export const STUDY_COMPLETION_CHECK_IDS = [
  'FOUR_ORACLE_RESULTS',
  'EQUALITY_EVALUATED',
  'EVIDENCE_INTEGRITY_VERIFIED',
  'NO_CONTRADICTORY_AMENDMENT',
  'NO_KNOWN_SAFETY_BREACH',
  'NO_REMAINING_OWNED_RESOURCE',
  'CLEAN_SOURCE_AND_MATCHING_QUALIFICATION',
] as const;
export type StudyCompletionCheckId = (typeof STUDY_COMPLETION_CHECK_IDS)[number];

/** BR-RUA-054 study completion. */
export const STUDY_COMPLETIONS = ['complete', 'incomplete'] as const;
export type StudyCompletion = (typeof STUDY_COMPLETIONS)[number];

/** Leak-audit discovery surfaces (design §9.14). */
export const LEAK_AUDIT_SURFACES = [
  'tag_index',
  'stack',
  'stack_resources',
  'functions',
  'event_source_mappings',
  'durable_executions',
  'queues',
  'tables',
  'log_groups',
  'roles',
] as const;
export type LeakAuditSurface = (typeof LEAK_AUDIT_SURFACES)[number];

/** D-30: what a leaked resource could still do; `processing_capable` and `unknown` compromise isolation. */
export const LEAK_CAPABILITY_CLASSES = ['processing_capable', 'storage_only', 'identity', 'unknown'] as const;
export type LeakCapabilityClass = (typeof LEAK_CAPABILITY_CLASSES)[number];

/** The BR-RUA-050 bases that prove ownership; a leak is an owned resource still observed. */
export const OWNED_BASES = [
  'recorded_stack',
  'resource_manifest_and_tags',
  'tags_name_type_created_after_freeze',
] as const;
export type OwnedBasis = (typeof OWNED_BASES)[number];

/** What cleanup did with one discovered resource (BR-RUA-048 step 9, BR-RUA-050). */
export const CLEANUP_RESOURCE_ACTIONS = [
  'DELETED',
  'ALREADY_ABSENT',
  'DELETE_FAILED',
  'SKIPPED_AMBIGUOUS',
  'EXCLUDED_BASELINE',
] as const;
export type CleanupResourceAction = (typeof CLEANUP_RESOURCE_ACTIONS)[number];

/** BR-RUA-047 billed-cost check. */
export const BILLED_COST_CHECKS = ['within_limit', 'breached', 'unverified'] as const;
export type BilledCostCheck = (typeof BILLED_COST_CHECKS)[number];

/** The reasons that make a billed-cost check `unverified` (design §8.17). */
export const BILLING_UNVERIFIED_CODES = [
  'INCOMPLETE_ATTRIBUTION',
  'NON_USD_LINE',
  'MIXED_CURRENCY',
  'INCOMPLETE_PERIOD',
  'SHARED_OR_UNOWNED_CHARGE',
] as const;
export type BillingUnverifiedCode = (typeof BILLING_UNVERIFIED_CODES)[number];

/** Billing lines excluded from attribution, each listed with its reason (design §8.17). */
export const BILLING_EXCLUSION_CODES = [
  'TAX',
  'CREDIT',
  'REFUND',
  'DISCOUNT',
  'FEE',
  'SAVINGS_PLAN',
  'OTHER_ACCOUNT',
  'NOT_RUN_OWNED',
  'OUTSIDE_USAGE_WINDOW',
] as const;
export type BillingExclusionCode = (typeof BILLING_EXCLUSION_CODES)[number];

/** Whether the BR-RUA-055 golden attestation passed. */
export const REVISION_CHECK_RESULTS = ['passed', 'failed'] as const;
export type RevisionCheckResult = (typeof REVISION_CHECK_RESULTS)[number];

/** Operator CLI outcomes, one per exit code of design §11. */
export const CLI_OUTCOMES = [
  'completed',
  'usage_error',
  'admission_rejected',
  'execution_incomplete',
  'verification_failed',
  'operational_closure_not_clean',
  'lease_problem',
  'internal_failure',
] as const;
export type CliOutcome = (typeof CLI_OUTCOMES)[number];

/** The exit code of each CLI outcome, in `CLI_OUTCOMES` order (design §11). */
export const CLI_EXIT_CODES = [0, 2, 3, 4, 5, 6, 7, 10] as const;
export type CliExitCode = (typeof CLI_EXIT_CODES)[number];
