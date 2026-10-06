// Canonical runner, lease and cleanup journal examples (catalogue rows 45-56): the run's phase
// machine, provisioning, the trial lifecycle, settlement, safety checks (BR-RUA-028..031,
// BR-RUA-046..050).

import type { CleanupActionRecorded } from '../../../../../src/record-contract/records/group-b/cleanup_action_recorded.ts';
import type { LeaseEventRecorded } from '../../../../../src/record-contract/records/group-b/lease_event_recorded.ts';
import type { PhaseTransitionRecorded } from '../../../../../src/record-contract/records/group-b/phase_transition_recorded.ts';
import type { ProbeWorkloadInvoked } from '../../../../../src/record-contract/records/group-b/probe_workload_invoked.ts';
import type { ProvisioningEventRecorded } from '../../../../../src/record-contract/records/group-b/provisioning_event_recorded.ts';
import type { SafetyCheckRecorded } from '../../../../../src/record-contract/records/group-b/safety_check_recorded.ts';
import type {
  EstablishedSettlement,
  NotEstablishedSettlement,
} from '../../../../../src/record-contract/records/group-b/settlement_assessed.ts';
import type { TreatmentArmed } from '../../../../../src/record-contract/records/group-b/treatment_armed.ts';
import type { TrialEvidenceFrozen } from '../../../../../src/record-contract/records/group-b/trial_evidence_frozen.ts';
import type { TrialInterrupted } from '../../../../../src/record-contract/records/group-b/trial_interrupted.ts';
import type { TrialMessagePublished } from '../../../../../src/record-contract/records/group-b/trial_message_published.ts';
import type { TrialPartitionsVerifiedAbsent } from '../../../../../src/record-contract/records/group-b/trial_partitions_verified_absent.ts';
import {
  EXECUTION_MANIFEST_SHA256,
  PROBE_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_PARTITION,
  at,
  digest,
  executionEnvelope,
  reason,
  trialEnvelope,
} from '../support/record-builders.ts';
import { example } from '../support/record-example.ts';
import type { RecordExample } from '../support/record-example.ts';

/**
 * The run entering its TRIALS phase.
 *
 * @example
 * toJson(phaseTransitionRecorded());
 */
export function phaseTransitionRecorded(): PhaseTransitionRecorded {
  return {
    ...executionEnvelope('phase_transition_recorded', 'run', 30, 1),
    source: 'runner',
    phase: 'TRIALS',
    status: 'started',
    reasons: [],
  };
}

/**
 * Provisioning verified the deploy copy against the inventory digest.
 *
 * @example
 * toJson(deployCopyVerified());
 */
export function deployCopyVerified(): ProvisioningEventRecorded {
  return {
    ...executionEnvelope('provisioning_event_recorded', 'run', 31, 2),
    source: 'runner',
    provisioning_event: 'DEPLOY_COPY_VERIFIED',
    inventory_sha256: digest('inventory'),
    reasons: [],
  };
}

/**
 * Provisioning started the stack deploy.
 *
 * @example
 * toJson(deployStarted());
 */
export function deployStarted(): ProvisioningEventRecorded {
  return {
    ...executionEnvelope('provisioning_event_recorded', 'run', 31, 2),
    source: 'runner',
    provisioning_event: 'DEPLOY_STARTED',
    stack_name: 'rua-run-0100',
    reasons: [],
  };
}

/**
 * Provisioning recorded the deployed stack id.
 *
 * @example
 * toJson(stackIdRecorded());
 */
export function stackIdRecorded(): ProvisioningEventRecorded {
  return {
    ...executionEnvelope('provisioning_event_recorded', 'run', 31, 2),
    source: 'runner',
    provisioning_event: 'STACK_ID_RECORDED',
    stack_id: 'arn:aws:cloudformation:eu-west-1:111122223333:stack/rua-run-0100/1',
    reasons: [],
  };
}

/**
 * A failed deploy, which must name at least one reason.
 *
 * @example
 * toJson(deployFailed());
 */
export function deployFailed(): ProvisioningEventRecorded {
  return {
    ...executionEnvelope('provisioning_event_recorded', 'run', 31, 2),
    source: 'runner',
    provisioning_event: 'DEPLOY_FAILED',
    stack_name: 'rua-run-0100',
    reasons: [reason('STACK_ROLLBACK_COMPLETE', 'cloudformation')],
  };
}

/**
 * The pre-trial check that no trial partition exists yet.
 *
 * @example
 * toJson(trialPartitionsVerifiedAbsent());
 */
export function trialPartitionsVerifiedAbsent(): TrialPartitionsVerifiedAbsent {
  return {
    ...trialEnvelope('trial_partitions_verified_absent', 32, 3),
    source: 'runner',
    partition_key: TRIAL_PARTITION,
    table_roles: ['caller_journal', 'control', 'experiment_journal', 'ledger'],
  };
}

/**
 * The runner arming the treatment of a COMMIT_THEN_TIMEOUT trial.
 *
 * @example
 * toJson(treatmentArmed());
 */
export function treatmentArmed(): TreatmentArmed {
  return {
    ...trialEnvelope('treatment_armed', 33, 4),
    source: 'runner',
    partition_key: TRIAL_PARTITION,
    treatment_state: 'ARMED',
    treatment_version: 1,
  };
}

/**
 * The trial message as SQS accepted it.
 *
 * @example
 * toJson(trialMessagePublished());
 */
export function trialMessagePublished(): TrialMessagePublished {
  return {
    ...trialEnvelope('trial_message_published', 34, 5),
    source: 'runner',
    variant_id: 'conventional',
    message_id: 'message-0001',
    sequence_number: '18889000000000000001',
    md5_of_message_body: '0123456789abcdef0123456789abcdef',
    message_body_sha256: digest('message-body'),
    message_group_id: 'trial-group-0001',
    message_deduplication_id: 'trial-dedup-0001',
  };
}

/**
 * A transport-probe workload invocation (probe execution, no trial).
 *
 * @example
 * toJson(probeWorkloadInvoked());
 */
export function probeWorkloadInvoked(): ProbeWorkloadInvoked {
  return {
    ...executionEnvelope('probe_workload_invoked', 'probe', 35, 1),
    source: 'runner',
    lambda_request_id: '7f9c1a2e-probe',
    status_code: 200,
    executed_version: '1',
    function_error: 'Unhandled',
  };
}

/**
 * Settlement established after one restart.
 *
 * @example
 * toJson(establishedSettlement());
 */
export function establishedSettlement(): EstablishedSettlement {
  return {
    ...trialEnvelope('settlement_assessed', 36, 6),
    source: 'runner',
    status: 'established',
    window_start: at(40_000),
    established_at: at(70_000),
    rechecked_at: at(71_000),
    reasons: [],
    restarts: [{ at: at(39_000), cause: 'SOURCE_IN_FLIGHT' }],
    sample_count: 4,
  };
}

/**
 * Settlement not established within the window.
 *
 * @example
 * toJson(notEstablishedSettlement());
 */
export function notEstablishedSettlement(): NotEstablishedSettlement {
  return {
    ...trialEnvelope('settlement_assessed', 36, 6),
    source: 'runner',
    status: 'not_established',
    reasons: [reason('SETTLEMENT_WINDOW_EXHAUSTED', 'settlement')],
    restarts: [],
    sample_count: 0,
  };
}

/**
 * The trial's evidence index frozen.
 *
 * @example
 * toJson(trialEvidenceFrozen());
 */
export function trialEvidenceFrozen(): TrialEvidenceFrozen {
  return {
    ...trialEnvelope('trial_evidence_frozen', 37, 7),
    source: 'runner',
    evidence_index_path: `trials/${TRIAL_ID}/evidence-index.json`,
    evidence_index_sha256: digest('evidence-index'),
  };
}

/**
 * A trial interrupted by the operator.
 *
 * @example
 * toJson(trialInterrupted());
 */
export function trialInterrupted(): TrialInterrupted {
  return {
    ...trialEnvelope('trial_interrupted', 38, 7),
    source: 'runner',
    cause: 'OPERATOR_ABORT',
    detail: 'operator sent SIGINT; expected the trial to finish',
  };
}

/**
 * An active-time safety check within its declared limit.
 *
 * @example
 * toJson(safetyCheckWithinLimits());
 */
export function safetyCheckWithinLimits(): SafetyCheckRecorded {
  return {
    ...executionEnvelope('safety_check_recorded', 'run', 39, 8),
    source: 'runner',
    boundary: 'ACTIVE_TIME',
    declared_limit: '120 minutes',
    observed: '65 minutes',
    result: 'within_limits',
    evidence_refs: [{ artifact_path: 'manifests/execution-manifest.json', artifact_sha256: EXECUTION_MANIFEST_SHA256 }],
    checked_at: at(39),
  };
}

/**
 * A billed-cost check that could not be verified (no observation required).
 *
 * @example
 * toJson(safetyCheckUnverified());
 */
export function safetyCheckUnverified(): SafetyCheckRecorded {
  return {
    ...executionEnvelope('safety_check_recorded', 'run', 39, 8),
    source: 'runner',
    boundary: 'BILLED_COST',
    declared_limit: 'USD 5.00',
    observed: 'Cost Explorer lag',
    result: 'unverified',
    evidence_refs: [],
    checked_at: at(39),
  };
}

/**
 * A failed lease acquisition naming the current holder.
 *
 * @example
 * toJson(leaseEventRecorded());
 */
export function leaseEventRecorded(): LeaseEventRecorded {
  return {
    ...executionEnvelope('lease_event_recorded', 'run', 40, 1),
    source: 'coordination_lease',
    lease_event: 'ACQUISITION_FAILED',
    owner_kind: 'RUN',
    owner_id: RUN_ID,
    owner_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    lease_version: 4,
    lease_health: 'CONFIRMED',
    last_confirmed_at: at(40),
    holder_owner_kind: 'TRANSPORT_PROBE',
    holder_owner_id: PROBE_ID,
    detail: 'lease held by a transport probe; expected no holder',
  };
}

/**
 * A cleanup step deleting the recorded stack.
 *
 * @example
 * toJson(cleanupResourceAction());
 */
export function cleanupResourceAction(): CleanupActionRecorded {
  return {
    ...executionEnvelope('cleanup_action_recorded', 'run', 41, 1),
    source: 'cleanup',
    step: 5,
    step_status: 'succeeded',
    cleanup_mode: 'NORMAL',
    cleanup_induced: false,
    action: 'DELETE_STACK',
    resource_type: 'AWS::CloudFormation::Stack',
    resource_identifier: 'rua-run-0100',
    ownership_basis: 'recorded_stack',
    reasons: [],
  };
}

/**
 * A cleanup step that names no resource.
 *
 * @example
 * toJson(cleanupStepAction());
 */
export function cleanupStepAction(): CleanupActionRecorded {
  return {
    ...executionEnvelope('cleanup_action_recorded', 'run', 41, 1),
    source: 'cleanup',
    step: 1,
    step_status: 'started',
    cleanup_mode: 'EMERGENCY',
    cleanup_induced: true,
    action: 'STOP_PUBLICATION',
    reasons: [reason('LEASE_LOST', 'coordination_lease')],
  };
}

export const RUNNER_EXAMPLES: readonly RecordExample[] = [
  example('phase_transition_recorded', phaseTransitionRecorded()),
  example('provisioning_event_recorded DEPLOY_COPY_VERIFIED', deployCopyVerified()),
  example('provisioning_event_recorded DEPLOY_STARTED', deployStarted()),
  example('provisioning_event_recorded STACK_ID_RECORDED', stackIdRecorded()),
  example('provisioning_event_recorded DEPLOY_FAILED', deployFailed(), { optional: ['stack_name'] }),
  example('trial_partitions_verified_absent', trialPartitionsVerifiedAbsent()),
  example('treatment_armed', treatmentArmed()),
  example('trial_message_published', trialMessagePublished()),
  example('probe_workload_invoked', probeWorkloadInvoked(), { optional: ['executed_version', 'function_error'] }),
  example('settlement_assessed established', establishedSettlement()),
  example('settlement_assessed not_established', notEstablishedSettlement()),
  example('trial_evidence_frozen', trialEvidenceFrozen()),
  example('trial_interrupted', trialInterrupted()),
  example('safety_check_recorded within_limits', safetyCheckWithinLimits()),
  example('safety_check_recorded unverified', safetyCheckUnverified(), { optional: ['observed'] }),
  example('lease_event_recorded', leaseEventRecorded(), {
    optional: ['lease_version', 'lease_health', 'last_confirmed_at', 'detail'],
  }),
  example('cleanup_action_recorded resource', cleanupResourceAction(), { optional: ['ownership_basis'] }),
  example('cleanup_action_recorded step', cleanupStepAction()),
];
