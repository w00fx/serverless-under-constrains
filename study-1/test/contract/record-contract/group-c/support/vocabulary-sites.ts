// Each closed vocabulary the group-C record modules export (or reuse from group B and the
// primitives) and the schema locations that must enforce exactly it, so a value added to or
// dropped from one side only fails the catalogue test. Fixed-order tuples are listed with the
// member whose `const` each position pins.

import {
  EXECUTION_KINDS,
  GATE_VALUES,
  RULE_OUTCOMES,
  SCENARIOS,
  VARIANT_IDS,
} from '../../../../../src/record-contract/primitives.ts';
import * as groupB from '../../../../../src/record-contract/records/group-b/vocabulary.ts';
import type { GroupCRecordType } from '../../../../../src/record-contract/records/group-c/record-map.ts';
import * as groupC from '../../../../../src/record-contract/records/group-c/vocabulary.ts';

export type VocabularySite = readonly [readonly (string | number | null)[], GroupCRecordType, string];

function propertyEnum(name: string): string {
  return `/properties/${name}/enum`;
}

function definitionEnum(definition: string, name: string): string {
  return `/$defs/${definition}/properties/${name}/enum`;
}

/** The code enum of a reason list whose items narrow `_defs` structured_reason. */
function reasonCodeEnum(member: string): string {
  return `/properties/${member}/items/allOf/1/properties/code/enum`;
}

const SUMMARY_CLOSURE: readonly GroupCRecordType[] = ['transport_probe_summary', 'validation_summary', 'run_summary'];

function summarySites(values: readonly string[], member: string): readonly VocabularySite[] {
  return SUMMARY_CLOSURE.map((recordType) => [values, recordType, propertyEnum(member)] as const);
}

export const VOCABULARY_SITES: readonly VocabularySite[] = [
  [groupC.PRESERVATION_VERDICTS, 'oracle_result', propertyEnum('preservation_verdict')],
  [groupC.PRESERVATION_VERDICTS, 'oracle_result', definitionEnum('condition_result', 'result')],
  [groupC.PRESERVATION_VERDICTS, 'transport_probe_result', propertyEnum('transport_probe_verdict')],
  [groupC.PRESERVATION_VERDICTS, 'run_summary', definitionEnum('trial_result', 'preservation_verdict')],
  [groupC.PRESERVATION_VERDICTS, 'validation_summary', definitionEnum('trial_result', 'preservation_verdict')],
  [groupC.PRESERVATION_VERDICTS, 'comparison_assessment', propertyEnum('equality_result')],
  [groupC.PRESERVATION_VERDICTS, 'comparison_assessment', definitionEnum('equality_projection', 'result')],
  [groupC.PRESERVATION_VERDICTS, 'probe_usability_assessment', propertyEnum('transport_probe_verdict')],
  [groupC.TRIAL_VALIDITIES, 'oracle_result', propertyEnum('trial_validity')],
  [groupC.TRIAL_VALIDITIES, 'transport_probe_result', propertyEnum('probe_validity')],
  [groupC.TRIAL_VALIDITIES, 'validation_summary', propertyEnum('validation_validity')],
  [groupC.TRIAL_VALIDITIES, 'probe_usability_assessment', propertyEnum('probe_validity')],
  [groupC.TRIAL_VALIDITIES, 'variant_validation_verification', propertyEnum('validation_validity')],
  [groupC.APPLICABLE_GATE_VALUES, 'transport_probe_result', propertyEnum('evidence_integrity')],
  [groupC.APPLICABLE_GATE_VALUES, 'transport_probe_result', propertyEnum('treatment_fidelity')],
  [groupC.APPLICABLE_GATE_VALUES, 'validation_summary', propertyEnum('evidence_integrity_status')],
  [groupC.APPLICABLE_GATE_VALUES, 'run_summary', propertyEnum('evidence_integrity_status')],
  [groupC.APPLICABLE_GATE_VALUES, 'probe_usability_assessment', propertyEnum('treatment_fidelity')],
  [groupC.APPLICABLE_GATE_VALUES, 'probe_usability_assessment', propertyEnum('evidence_integrity')],
  [GATE_VALUES, 'oracle_result', propertyEnum('identity_integrity')],
  [GATE_VALUES, 'oracle_result', propertyEnum('control_integrity')],
  [GATE_VALUES, 'oracle_result', propertyEnum('treatment_fidelity')],
  [GATE_VALUES, 'oracle_result', definitionEnum('validity_gate', 'value')],
  [RULE_OUTCOMES, 'oracle_result', definitionEnum('rule_result', 'result')],
  [groupC.GATE_IDS, 'oracle_result', definitionEnum('validity_gate', 'gate')],
  [groupC.ORACLE_RULE_IDS, 'oracle_result', definitionEnum('rule_result', 'rule_id')],
  [groupC.CONDITION_IDS, 'oracle_result', definitionEnum('condition_result', 'condition_id')],
  [groupC.CONDITION_IDS, 'transport_probe_result', definitionEnum('condition_result', 'condition_id')],
  [groupC.FIDELITY_BASES, 'oracle_result', propertyEnum('fidelity_basis')],
  [groupC.CLOCK_ASSUMPTION_IDS, 'oracle_result', '/properties/clock_assumption_refs/items/enum'],
  [groupC.CLOCK_ASSUMPTION_IDS, 'transport_probe_result', '/properties/clock_assumption_refs/items/enum'],
  [groupC.ORDERING_BASES, 'transport_probe_result', propertyEnum('ordering_basis')],
  [groupC.INGESTION_FINDING_CODES, 'oracle_result', '/$defs/condition_result/properties/affected_by/items/enum'],
  [
    groupC.INGESTION_FINDING_CODES,
    'transport_probe_result',
    '/$defs/condition_result/properties/affected_by/items/enum',
  ],
  [[...groupB.PROCESSING_TERMINAL_REASONS, null], 'oracle_result', propertyEnum('processing_terminal_reason')],
  [VARIANT_IDS, 'oracle_result', propertyEnum('variant_id')],
  [SCENARIOS, 'oracle_result', propertyEnum('scenario')],
  [groupC.OUTCOME_CLASSES, 'attempt_projection', definitionEnum('attempt', 'outcome_class')],
  [groupC.PROVIDER_CALL_DISPOSITIONS, 'attempt_projection', definitionEnum('provider_call', 'disposition')],
  [groupB.CALLER_EVENT_SOURCES, 'attempt_projection', definitionEnum('invocation', 'source')],
  [groupB.DISPATCH_STATES, 'attempt_projection', definitionEnum('attempt', 'dispatch_state')],
  [groupB.ATTEMPT_OUTCOMES, 'attempt_projection', definitionEnum('attempt', 'outcome')],
  [groupB.EFFECT_KNOWLEDGE_STATES, 'attempt_projection', definitionEnum('attempt', 'knowledge_after_derived')],
  [groupB.EFFECT_KNOWLEDGE_STATES, 'attempt_projection', definitionEnum('attempt', 'knowledge_after_recorded')],
  [groupB.TRANSPORT_SETTLEMENT_KINDS, 'attempt_projection', definitionEnum('late_settlement', 'settlement_kind')],
  [groupB.PROVIDER_REJECTION_REASONS, 'attempt_projection', definitionEnum('provider_call', 'rejection_reason')],
  [groupB.DURABLE_EXECUTION_STATUSES, 'attempt_projection', definitionEnum('durable_execution', 'status')],
  [groupC.EVIDENCE_INDEX_SCOPES, 'evidence_index', propertyEnum('index_scope')],
  [groupC.ARTIFACT_CLASSES, 'evidence_index', definitionEnum('index_entry', 'artifact_class')],
  [groupC.ARTIFACT_CLASSES, 'package_index', definitionEnum('index_entry', 'artifact_class')],
  [groupC.ARTIFACT_CLASSES, 'amendment_index', definitionEnum('index_entry', 'artifact_class')],
  [groupC.ARTIFACT_DERIVATIONS, 'evidence_index', definitionEnum('index_entry', 'derivation')],
  [groupC.ARTIFACT_DERIVATIONS, 'package_index', definitionEnum('index_entry', 'derivation')],
  [groupC.ARTIFACT_DERIVATIONS, 'amendment_index', definitionEnum('index_entry', 'derivation')],
  [groupC.PROBE_TERMINAL_REASONS, 'transport_probe_summary', propertyEnum('probe_terminal_reason')],
  [groupC.VALIDATION_TERMINAL_REASONS, 'validation_summary', propertyEnum('validation_terminal_reason')],
  [groupC.RUN_TERMINAL_REASONS, 'run_summary', propertyEnum('run_terminal_reason')],
  [groupC.RUN_TERMINAL_REASONS, 'study_completion_assessment', propertyEnum('run_terminal_reason')],
  [groupC.EXECUTION_STATUSES, 'run_summary', propertyEnum('execution_status')],
  [groupC.TRIAL_EXECUTION_STATUSES, 'run_summary', definitionEnum('trial_result', 'execution_status')],
  [groupC.TRIAL_EXECUTION_STATUSES, 'validation_summary', definitionEnum('trial_result', 'execution_status')],
  [groupC.IMPLEMENTATION_VALIDATION_STATUSES, 'validation_summary', propertyEnum('implementation_validation_status')],
  [
    groupC.IMPLEMENTATION_VALIDATION_STATUSES,
    'variant_validation_verification',
    propertyEnum('declared_implementation_validation_status'),
  ],
  [
    groupC.IMPLEMENTATION_VALIDATION_STATUSES,
    'variant_validation_verification',
    propertyEnum('effective_implementation_validation_status'),
  ],
  [VARIANT_IDS, 'validation_summary', propertyEnum('variant_id')],
  ...summarySites(groupC.CLEANUP_STATUSES, 'cleanup_status'),
  ...summarySites(groupC.LEAK_AUDIT_STATUSES, 'leak_audit_status'),
  ...summarySites(groupC.LEASE_STATUSES, 'lease_status'),
  ...summarySites(groupB.SAFETY_RESULTS, 'safety_status'),
  [groupC.LATE_EVIDENCE_STATUSES, 'transport_probe_summary', propertyEnum('late_evidence_status')],
  [groupC.LATE_EVIDENCE_STATUSES, 'validation_summary', propertyEnum('late_evidence_status')],
  [groupC.ELIGIBILITIES, 'run_summary', propertyEnum('comparison_eligibility')],
  [groupC.ELIGIBILITIES, 'comparison_assessment', propertyEnum('comparison_eligibility')],
  [groupC.EQUALITY_PROJECTION_IDS, 'comparison_assessment', definitionEnum('equality_projection', 'projection_id')],
  [groupC.COMPARISON_CHECK_IDS, 'comparison_assessment', definitionEnum('comparison_check', 'check_id')],
  [groupB.SAFETY_RESULTS, 'safety_assessment', propertyEnum('safety_status')],
  [groupB.SAFETY_RESULTS, 'safety_assessment', definitionEnum('safety_check', 'result')],
  [groupB.SAFETY_BOUNDARIES, 'safety_assessment', definitionEnum('safety_check', 'boundary')],
  [groupB.CLEANUP_MODES, 'cleanup_result', propertyEnum('cleanup_mode')],
  [groupC.CLEANUP_STATUSES, 'cleanup_result', propertyEnum('cleanup_status')],
  [groupB.STEP_STATUSES, 'cleanup_result', definitionEnum('cleanup_step', 'status')],
  [groupB.OWNERSHIP_BASES, 'cleanup_result', definitionEnum('cleanup_resource', 'ownership_basis')],
  [groupC.CLEANUP_RESOURCE_ACTIONS, 'cleanup_result', definitionEnum('cleanup_resource', 'action')],
  [groupC.LEAK_AUDIT_STATUSES, 'leak_audit_result', propertyEnum('leak_audit_status')],
  [groupC.LEAK_AUDIT_SURFACES, 'leak_audit_result', definitionEnum('surface_observation', 'surface')],
  [groupC.LEAK_AUDIT_SURFACES, 'leak_audit_result', definitionEnum('leak', 'surface')],
  [groupC.LEAK_AUDIT_SURFACES, 'leak_audit_result', definitionEnum('ambiguous_resource', 'surface')],
  [groupC.LEAK_CAPABILITY_CLASSES, 'leak_audit_result', definitionEnum('leak', 'capability_class')],
  [groupC.OWNED_BASES, 'leak_audit_result', definitionEnum('leak', 'ownership_basis')],
  [groupC.LATE_EVIDENCE_SOURCES, 'late_evidence_record', propertyEnum('late_source')],
  [groupC.LATE_EVIDENCE_STATUSES, 'late_evidence_assessment', propertyEnum('late_evidence_status')],
  [groupC.LATE_EVIDENCE_STATUSES, 'late_evidence_assessment', definitionEnum('reassessment', 'status')],
  [groupC.LATE_MONITORING_OUTCOMES, 'late_evidence_assessment', propertyEnum('monitoring')],
  [EXECUTION_KINDS, 'package_index', propertyEnum('execution_kind')],
  [groupC.ELIGIBILITIES, 'package_verification', propertyEnum('package_eligibility')],
  [groupC.PACKAGE_INELIGIBILITY_CODES, 'package_verification', reasonCodeEnum('package_ineligibility_reasons')],
  [groupC.AMENDMENT_KINDS, 'package_verification', definitionEnum('amendment_link', 'amendment_kind')],
  [groupC.AMENDMENT_KINDS, 'amendment_index', propertyEnum('amendment_kind')],
  [groupC.PROBE_USABILITIES, 'probe_usability_assessment', propertyEnum('probe_usability')],
  [groupC.PROBE_UNUSABILITY_CODES, 'probe_usability_assessment', reasonCodeEnum('reasons')],
  [groupC.LATE_EVIDENCE_STATUSES, 'probe_usability_assessment', propertyEnum('late_evidence_status')],
  [groupC.EFFECTIVE_CLEANUP_STATUSES, 'probe_usability_assessment', propertyEnum('effective_cleanup_status')],
  [groupC.EFFECTIVE_LEAK_AUDIT_STATUSES, 'probe_usability_assessment', propertyEnum('effective_leak_audit_status')],
  [groupC.LEASE_STATUSES, 'probe_usability_assessment', propertyEnum('effective_lease_status')],
  [groupB.SAFETY_RESULTS, 'probe_usability_assessment', propertyEnum('safety_status')],
  [groupC.ELIGIBILITIES, 'probe_usability_assessment', propertyEnum('package_eligibility')],
  [groupC.ELIGIBILITIES, 'variant_validation_verification', propertyEnum('package_eligibility')],
  [groupC.EFFECTIVE_CLEANUP_STATUSES, 'variant_validation_verification', propertyEnum('effective_cleanup_status')],
  [
    groupC.EFFECTIVE_LEAK_AUDIT_STATUSES,
    'variant_validation_verification',
    propertyEnum('effective_leak_audit_status'),
  ],
  [groupC.LEASE_STATUSES, 'variant_validation_verification', propertyEnum('effective_lease_status')],
  [groupC.STUDY_COMPLETIONS, 'study_completion_assessment', propertyEnum('study_completion')],
  [groupC.ELIGIBILITIES, 'study_completion_assessment', propertyEnum('comparison_eligibility')],
  [groupC.ELIGIBILITIES, 'study_completion_assessment', propertyEnum('package_eligibility')],
  [groupC.CLEANUP_STATUSES, 'study_completion_assessment', propertyEnum('cleanup_status')],
  [groupC.LEAK_AUDIT_STATUSES, 'study_completion_assessment', propertyEnum('leak_audit_status')],
  [groupC.LEASE_STATUSES, 'study_completion_assessment', propertyEnum('lease_status')],
  [groupC.STUDY_COMPLETION_CHECK_IDS, 'study_completion_assessment', definitionEnum('completion_check', 'check_id')],
  [groupC.TERMINAL_CLEANUP_STATUSES, 'operational_recovery_record', definitionEnum('closure', 'cleanup_status')],
  [groupC.LEAK_AUDIT_STATUSES, 'operational_recovery_record', definitionEnum('closure', 'leak_audit_status')],
  [groupC.LEASE_STATUSES, 'operational_recovery_record', definitionEnum('closure', 'lease_status')],
  [groupC.BILLED_COST_CHECKS, 'billing_import', propertyEnum('billed_cost_check')],
  [groupC.BILLING_UNVERIFIED_CODES, 'billing_import', reasonCodeEnum('reasons')],
  [groupC.BILLING_EXCLUSION_CODES, 'billing_import', definitionEnum('excluded_line', 'exclusion')],
  [groupC.REVISION_CHECK_RESULTS, 'oracle_revision_check', propertyEnum('result')],
  [groupC.CLI_OUTCOMES, 'cli_result', propertyEnum('outcome')],
  [groupC.CLI_EXIT_CODES, 'cli_result', propertyEnum('exit_code')],
];

/** A fixed-order tuple: the values each position pins, by the member whose `const` pins it. */
export type OrderSite = readonly [readonly (string | number)[], GroupCRecordType, string, string];

export const ORDER_SITES: readonly OrderSite[] = [
  [groupC.GATE_IDS, 'oracle_result', '/properties/validity_gates', 'gate'],
  [groupC.ORACLE_RULE_IDS, 'oracle_result', '/properties/rule_results', 'rule_id'],
  [groupC.CONDITION_IDS, 'oracle_result', '/allOf/1/else/properties/treatment_condition_results', 'condition_id'],
  [groupC.CONDITION_IDS, 'transport_probe_result', '/properties/condition_results', 'condition_id'],
  [groupC.EQUALITY_PROJECTION_IDS, 'comparison_assessment', '/properties/equality_projections', 'projection_id'],
  [groupC.COMPARISON_CHECK_IDS, 'comparison_assessment', '/properties/eligibility_checks', 'check_id'],
  [groupC.STUDY_COMPLETION_CHECK_IDS, 'study_completion_assessment', '/properties/checks', 'check_id'],
  [[1, 2, 3, 4], 'run_summary', '/properties/trial_results', 'sequence'],
  [['conventional', 'durable', 'conventional', 'durable'], 'run_summary', '/properties/trial_results', 'variant_id'],
  [
    ['CONTROL', 'CONTROL', 'COMMIT_THEN_TIMEOUT', 'COMMIT_THEN_TIMEOUT'],
    'run_summary',
    '/properties/trial_results',
    'scenario',
  ],
  [[1, 2], 'validation_summary', '/properties/trial_results', 'sequence'],
  [SCENARIOS, 'validation_summary', '/properties/trial_results', 'scenario'],
];
