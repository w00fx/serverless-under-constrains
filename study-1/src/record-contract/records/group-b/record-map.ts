// The record type of every group-B name, so generic code (for example the event journal's
// `EventBody<T>`) can map a `record_type` to its interface without a barrel that spans the
// three catalogue groups (design §13 contention rule 2). Type-only: it has no runtime part.

import type { CallerInvocationStarted } from './caller_invocation_started.ts';
import type { TrialMessageRejected } from './trial_message_rejected.ts';
import type { AttemptRegistered } from './attempt_registered.ts';
import type { AttemptNotDispatched } from './attempt_not_dispatched.ts';
import type { DispatchStarted } from './dispatch_started.ts';
import type { CallerTimeoutRecorded } from './caller_timeout_recorded.ts';
import type { TransportSettledAfterTimeout } from './transport_settled_after_timeout.ts';
import type { AttemptOutcomeRecorded } from './attempt_outcome_recorded.ts';
import type { RequestStateRecorded } from './request_state_recorded.ts';
import type { InnerExecutionExhausted } from './inner_execution_exhausted.ts';
import type { ProviderCallReceived } from './provider_call_received.ts';
import type { ProviderCallRejected } from './provider_call_rejected.ts';
import type { ProviderCallAccepted } from './provider_call_accepted.ts';
import type { ProviderTransactionCommitted } from './provider_transaction_committed.ts';
import type { ProviderCommitConfirmed } from './provider_commit_confirmed.ts';
import type { ProviderCommitFailed } from './provider_commit_failed.ts';
import type { TreatmentTimeoutObserved } from './treatment_timeout_observed.ts';
import type { TreatmentResponseReleased } from './treatment_response_released.ts';
import type { TreatmentSafetyReleased } from './treatment_safety_released.ts';
import type { ProviderResponseReturned } from './provider_response_returned.ts';
import type { TimeoutSignalRecorded } from './timeout_signal_recorded.ts';
import type { TimeoutSignalDuplicateObserved } from './timeout_signal_duplicate_observed.ts';
import type { TimeoutSignalConflictRecorded } from './timeout_signal_conflict_recorded.ts';
import type { LateTimeoutSignalRejected } from './late_timeout_signal_rejected.ts';
import type { CallerTimeoutRejected } from './caller_timeout_rejected.ts';
import type { ControllerCanaryAcknowledged } from './controller_canary_acknowledged.ts';
import type { PhaseTransitionRecorded } from './phase_transition_recorded.ts';
import type { ProvisioningEventRecorded } from './provisioning_event_recorded.ts';
import type { TrialPartitionsVerifiedAbsent } from './trial_partitions_verified_absent.ts';
import type { TreatmentArmed } from './treatment_armed.ts';
import type { TrialMessagePublished } from './trial_message_published.ts';
import type { ProbeWorkloadInvoked } from './probe_workload_invoked.ts';
import type { SettlementAssessed } from './settlement_assessed.ts';
import type { TrialEvidenceFrozen } from './trial_evidence_frozen.ts';
import type { TrialInterrupted } from './trial_interrupted.ts';
import type { SafetyCheckRecorded } from './safety_check_recorded.ts';
import type { LeaseEventRecorded } from './lease_event_recorded.ts';
import type { CleanupActionRecorded } from './cleanup_action_recorded.ts';
import type { QueueObservation } from './queue_observation.ts';
import type { SettlementSample } from './settlement_sample.ts';
import type { DlqSnapshot } from './dlq_snapshot.ts';
import type { LedgerSnapshot } from './ledger_snapshot.ts';
import type { TreatmentStateSnapshot } from './treatment_state_snapshot.ts';
import type { DurableExecutionMetadata } from './durable_execution_metadata.ts';
import type { TelemetryAvailabilityRecord } from './telemetry_availability.ts';
import type { PreCleanupSnapshot } from './pre_cleanup_snapshot.ts';
import type { CoordinationPrefixCheckpoint } from './coordination_prefix_checkpoint.ts';
import type { ProviderWarmupRequest } from './provider_warmup_request.ts';
import type { ProviderWarmupCompleted } from './provider_warmup_completed.ts';

/**
 * Maps each group-B `record_type` to its TypeScript record type.
 *
 * @example
 * type Timeout = GroupBRecordByType['caller_timeout_recorded']; // CallerTimeoutRecorded
 */
export interface GroupBRecordByType {
  readonly caller_invocation_started: CallerInvocationStarted;
  readonly trial_message_rejected: TrialMessageRejected;
  readonly attempt_registered: AttemptRegistered;
  readonly attempt_not_dispatched: AttemptNotDispatched;
  readonly dispatch_started: DispatchStarted;
  readonly caller_timeout_recorded: CallerTimeoutRecorded;
  readonly transport_settled_after_timeout: TransportSettledAfterTimeout;
  readonly attempt_outcome_recorded: AttemptOutcomeRecorded;
  readonly request_state_recorded: RequestStateRecorded;
  readonly inner_execution_exhausted: InnerExecutionExhausted;
  readonly provider_call_received: ProviderCallReceived;
  readonly provider_call_rejected: ProviderCallRejected;
  readonly provider_call_accepted: ProviderCallAccepted;
  readonly provider_transaction_committed: ProviderTransactionCommitted;
  readonly provider_commit_confirmed: ProviderCommitConfirmed;
  readonly provider_commit_failed: ProviderCommitFailed;
  readonly treatment_timeout_observed: TreatmentTimeoutObserved;
  readonly treatment_response_released: TreatmentResponseReleased;
  readonly treatment_safety_released: TreatmentSafetyReleased;
  readonly provider_response_returned: ProviderResponseReturned;
  readonly timeout_signal_recorded: TimeoutSignalRecorded;
  readonly timeout_signal_duplicate_observed: TimeoutSignalDuplicateObserved;
  readonly timeout_signal_conflict_recorded: TimeoutSignalConflictRecorded;
  readonly late_timeout_signal_rejected: LateTimeoutSignalRejected;
  readonly caller_timeout_rejected: CallerTimeoutRejected;
  readonly controller_canary_acknowledged: ControllerCanaryAcknowledged;
  readonly phase_transition_recorded: PhaseTransitionRecorded;
  readonly provisioning_event_recorded: ProvisioningEventRecorded;
  readonly trial_partitions_verified_absent: TrialPartitionsVerifiedAbsent;
  readonly treatment_armed: TreatmentArmed;
  readonly trial_message_published: TrialMessagePublished;
  readonly probe_workload_invoked: ProbeWorkloadInvoked;
  readonly settlement_assessed: SettlementAssessed;
  readonly trial_evidence_frozen: TrialEvidenceFrozen;
  readonly trial_interrupted: TrialInterrupted;
  readonly safety_check_recorded: SafetyCheckRecorded;
  readonly lease_event_recorded: LeaseEventRecorded;
  readonly cleanup_action_recorded: CleanupActionRecorded;
  readonly queue_observation: QueueObservation;
  readonly settlement_sample: SettlementSample;
  readonly dlq_snapshot: DlqSnapshot;
  readonly ledger_snapshot: LedgerSnapshot;
  readonly treatment_state_snapshot: TreatmentStateSnapshot;
  readonly durable_execution_metadata: DurableExecutionMetadata;
  readonly telemetry_availability: TelemetryAvailabilityRecord;
  readonly pre_cleanup_snapshot: PreCleanupSnapshot;
  readonly coordination_prefix_checkpoint: CoordinationPrefixCheckpoint;
  readonly provider_warmup_request: ProviderWarmupRequest;
  readonly provider_warmup_completed: ProviderWarmupCompleted;
}

/** A group-B record type name. */
export type GroupBRecordType = keyof GroupBRecordByType;

/** Any group-B record. */
export type GroupBRecord = GroupBRecordByType[GroupBRecordType];
