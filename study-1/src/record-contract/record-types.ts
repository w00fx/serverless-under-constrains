// The closed record-type catalogue (design §6.2, addendum §3, Owner amendment A-09). WP-00 creates the full list
// up front so later packages never edit a shared file: group A belongs to WP-01, group B
// to WP-02 and group C to WP-03. Each group directory under `schemas/` and `records/`
// holds one file per name listed here.

export const RECORD_TYPE_GROUPS = {
  'group-a': [
    'environment_input',
    'payment',
    'approved_decision',
    'trial_message',
    'provider_refund_call',
    'provider_refund_response',
    'probe_workload_request',
    'admission_rejection',
    'preflight_check_recorded',
    'source_provenance',
    'deployment_assembly_inventory',
    'transport_scope_policy',
    'transport_scope_snapshot',
    'execution_manifest',
    'resource_manifest',
    'trial_manifest',
    'provider_trial_configuration',
    // Owner amendment A-09 (human decision): the execution-level control `config` item, catalogued
    // beside the per-trial one it mirrors.
    'provider_execution_configuration',
    'trial_registration',
  ],
  'group-b': [
    'caller_invocation_started',
    'trial_message_rejected',
    'attempt_registered',
    'attempt_not_dispatched',
    'dispatch_started',
    'caller_timeout_recorded',
    'transport_settled_after_timeout',
    'attempt_outcome_recorded',
    'request_state_recorded',
    'inner_execution_exhausted',
    'provider_call_received',
    'provider_call_rejected',
    'provider_call_accepted',
    'provider_transaction_committed',
    'provider_commit_confirmed',
    'provider_commit_failed',
    'treatment_timeout_observed',
    'treatment_response_released',
    'treatment_safety_released',
    'provider_response_returned',
    'timeout_signal_recorded',
    'timeout_signal_duplicate_observed',
    'timeout_signal_conflict_recorded',
    'late_timeout_signal_rejected',
    'caller_timeout_rejected',
    'controller_canary_acknowledged',
    'phase_transition_recorded',
    'provisioning_event_recorded',
    'trial_partitions_verified_absent',
    'treatment_armed',
    'trial_message_published',
    'probe_workload_invoked',
    'settlement_assessed',
    'trial_evidence_frozen',
    'trial_interrupted',
    'safety_check_recorded',
    'lease_event_recorded',
    'cleanup_action_recorded',
    'queue_observation',
    'settlement_sample',
    'dlq_snapshot',
    'ledger_snapshot',
    'treatment_state_snapshot',
    'durable_execution_metadata',
    'telemetry_availability',
    'pre_cleanup_snapshot',
    'coordination_prefix_checkpoint',
    // Addendum §2/§3 (D-27 resolution): provider warm-up readiness evidence.
    'provider_warmup_request',
    'provider_warmup_completed',
  ],
  'group-c': [
    'attempt_projection',
    'oracle_result',
    'evidence_index',
    'transport_probe_result',
    'transport_probe_summary',
    'validation_summary',
    'run_summary',
    'comparison_assessment',
    'safety_assessment',
    'cleanup_result',
    'leak_audit_result',
    'late_evidence_record',
    'late_evidence_assessment',
    'package_index',
    'package_verification',
    'probe_usability_assessment',
    'variant_validation_verification',
    'study_completion_assessment',
    'amendment_index',
    'operational_recovery_record',
    'billing_import',
    'oracle_revision_check',
    'cli_result',
  ],
} as const;

export type RecordGroup = keyof typeof RECORD_TYPE_GROUPS;
export type RecordType = (typeof RECORD_TYPE_GROUPS)[RecordGroup][number];

export const RECORD_GROUPS: readonly RecordGroup[] = ['group-a', 'group-b', 'group-c'];

/** Every catalogued record type, in catalogue order (91 names: addendum §3 and A-09). */
export const RECORD_TYPES: readonly RecordType[] = [
  ...RECORD_TYPE_GROUPS['group-a'],
  ...RECORD_TYPE_GROUPS['group-b'],
  ...RECORD_TYPE_GROUPS['group-c'],
];

/**
 * Journal events: the records that carry the event envelope (design §6.2 kind E, plus the
 * provider's warm-up completion event from addendum §2).
 */
export const EVENT_RECORD_TYPES = [
  'caller_invocation_started',
  'trial_message_rejected',
  'attempt_registered',
  'attempt_not_dispatched',
  'dispatch_started',
  'caller_timeout_recorded',
  'transport_settled_after_timeout',
  'attempt_outcome_recorded',
  'request_state_recorded',
  'inner_execution_exhausted',
  'provider_call_received',
  'provider_call_rejected',
  'provider_call_accepted',
  'provider_transaction_committed',
  'provider_commit_confirmed',
  'provider_commit_failed',
  'treatment_timeout_observed',
  'treatment_response_released',
  'treatment_safety_released',
  'provider_response_returned',
  'timeout_signal_recorded',
  'timeout_signal_duplicate_observed',
  'timeout_signal_conflict_recorded',
  'late_timeout_signal_rejected',
  'caller_timeout_rejected',
  'controller_canary_acknowledged',
  'phase_transition_recorded',
  'provisioning_event_recorded',
  'trial_partitions_verified_absent',
  'treatment_armed',
  'trial_message_published',
  'probe_workload_invoked',
  'settlement_assessed',
  'trial_evidence_frozen',
  'trial_interrupted',
  'safety_check_recorded',
  'lease_event_recorded',
  'cleanup_action_recorded',
  'provider_warmup_completed',
] as const satisfies readonly RecordType[];

export type EventRecordType = (typeof EVENT_RECORD_TYPES)[number];

const RECORD_TYPE_SET: ReadonlySet<string> = new Set(RECORD_TYPES);
const EVENT_RECORD_TYPE_SET: ReadonlySet<string> = new Set(EVENT_RECORD_TYPES);

/**
 * Narrows an arbitrary value to a catalogued record type name.
 *
 * @example
 * isRecordType('payment'); // true
 * isRecordType('Payment'); // false
 */
export function isRecordType(value: unknown): value is RecordType {
  return typeof value === 'string' && RECORD_TYPE_SET.has(value);
}

/**
 * Tells whether a record type is a journal event that carries the event envelope.
 *
 * @example
 * isEventRecordType('dispatch_started'); // true
 * isEventRecordType('payment'); // false
 */
export function isEventRecordType(value: RecordType): value is EventRecordType {
  return EVENT_RECORD_TYPE_SET.has(value);
}

/**
 * Returns the catalogue group (and therefore the owning schema directory) of a record type.
 *
 * @example
 * recordGroupOf('oracle_result'); // 'group-c'
 */
export function recordGroupOf(recordType: RecordType): RecordGroup {
  const group = RECORD_GROUPS.find((candidate) =>
    (RECORD_TYPE_GROUPS[candidate] as readonly string[]).includes(recordType),
  );
  if (group === undefined) {
    throw new RangeError(
      `record type ${JSON.stringify(recordType)} is in no catalogue group; expected one of RECORD_TYPES`,
    );
  }
  return group;
}
