// Every group-B example in one list, and one canonical example per record type. The mapped
// type makes the canonical table fail to compile when a record type lacks an example or an
// example has the wrong record type, so "every group-B type has a valid example" is total.

import type {
  GroupBRecordByType,
  GroupBRecordType,
} from '../../../../../src/record-contract/records/group-b/record-map.ts';
import type { RecordExample } from '../support/record-example.ts';
import * as caller from './caller-examples.ts';
import * as controller from './controller-examples.ts';
import * as observation from './observation-examples.ts';
import * as provider from './provider-examples.ts';
import * as runner from './runner-examples.ts';

type CanonicalExamples = { readonly [K in GroupBRecordType]: () => GroupBRecordByType[K] };

export const CANONICAL_EXAMPLES: CanonicalExamples = {
  caller_invocation_started: caller.conventionalInvocationStarted,
  trial_message_rejected: caller.trialMessageRejected,
  attempt_registered: caller.attemptRegistered,
  attempt_not_dispatched: caller.attemptNotDispatched,
  dispatch_started: caller.dispatchStarted,
  caller_timeout_recorded: caller.callerTimeoutRecorded,
  transport_settled_after_timeout: caller.transportSettledAfterTimeout,
  attempt_outcome_recorded: caller.succeededOutcome,
  request_state_recorded: caller.finishedRequestState,
  inner_execution_exhausted: caller.innerExecutionExhausted,
  provider_call_received: provider.providerCallReceived,
  provider_call_rejected: provider.providerCallRejected,
  provider_call_accepted: provider.providerCallAccepted,
  provider_transaction_committed: provider.providerTransactionCommitted,
  provider_commit_confirmed: provider.providerCommitConfirmed,
  provider_commit_failed: provider.providerCommitFailed,
  treatment_timeout_observed: provider.treatmentTimeoutObserved,
  treatment_response_released: provider.treatmentResponseReleased,
  treatment_safety_released: provider.committedSafetyRelease,
  provider_response_returned: provider.providerResponseReturned,
  provider_warmup_request: provider.providerWarmupRequest,
  provider_warmup_completed: provider.providerWarmupCompleted,
  timeout_signal_recorded: controller.timeoutSignalRecorded,
  timeout_signal_duplicate_observed: controller.timeoutSignalDuplicateObserved,
  timeout_signal_conflict_recorded: controller.timeoutSignalConflictRecorded,
  late_timeout_signal_rejected: controller.lateTimeoutSignalRejected,
  caller_timeout_rejected: controller.notTargetedCallerTimeout,
  controller_canary_acknowledged: controller.controllerCanaryAcknowledged,
  phase_transition_recorded: runner.phaseTransitionRecorded,
  provisioning_event_recorded: runner.deployCopyVerified,
  trial_partitions_verified_absent: runner.trialPartitionsVerifiedAbsent,
  treatment_armed: runner.treatmentArmed,
  trial_message_published: runner.trialMessagePublished,
  probe_workload_invoked: runner.probeWorkloadInvoked,
  settlement_assessed: runner.establishedSettlement,
  trial_evidence_frozen: runner.trialEvidenceFrozen,
  trial_interrupted: runner.trialInterrupted,
  safety_check_recorded: runner.safetyCheckWithinLimits,
  lease_event_recorded: runner.leaseEventRecorded,
  cleanup_action_recorded: runner.cleanupResourceAction,
  queue_observation: observation.queueCountersObserved,
  settlement_sample: observation.settlementSample,
  dlq_snapshot: observation.dlqSnapshot,
  ledger_snapshot: observation.ledgerSnapshot,
  treatment_state_snapshot: observation.treatmentItemPresent,
  durable_execution_metadata: observation.durableExecutionMetadata,
  telemetry_availability: observation.telemetryAvailability,
  pre_cleanup_snapshot: observation.preCleanupSnapshot,
  coordination_prefix_checkpoint: observation.coordinationPrefixCheckpoint,
};

export const GROUP_B_EXAMPLES: readonly RecordExample[] = [
  ...caller.CALLER_EXAMPLES,
  ...provider.PROVIDER_EXAMPLES,
  ...controller.CONTROLLER_EXAMPLES,
  ...runner.RUNNER_EXAMPLES,
  ...observation.OBSERVATION_EXAMPLES,
];
