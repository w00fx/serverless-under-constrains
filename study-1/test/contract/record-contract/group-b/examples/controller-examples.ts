// Canonical treatment-controller examples (catalogue rows 39-44): the controller turning the
// caller's timeout record into a signal for the held commit (BR-RUA-024..026).

import type {
  BeforeCommitCallerTimeout,
  ControlTrialCallerTimeout,
  InvalidCallerTimeout,
  NotTargetedCallerTimeout,
} from '../../../../../src/record-contract/records/group-b/caller_timeout_rejected.ts';
import type { ControllerCanaryAcknowledged } from '../../../../../src/record-contract/records/group-b/controller_canary_acknowledged.ts';
import type { LateTimeoutSignalRejected } from '../../../../../src/record-contract/records/group-b/late_timeout_signal_rejected.ts';
import type { TimeoutSignalConflictRecorded } from '../../../../../src/record-contract/records/group-b/timeout_signal_conflict_recorded.ts';
import type { TimeoutSignalDuplicateObserved } from '../../../../../src/record-contract/records/group-b/timeout_signal_duplicate_observed.ts';
import type { TimeoutSignalRecorded } from '../../../../../src/record-contract/records/group-b/timeout_signal_recorded.ts';
import {
  ATTEMPT_CORRELATION,
  COMMIT_TRIPLE,
  executionEnvelope,
  trialEnvelope,
  uuid,
} from '../support/record-builders.ts';
import { example } from '../support/record-example.ts';
import type { RecordExample } from '../support/record-example.ts';

const CALLER_TIMEOUT_EVENT_ID = uuid(6);
const COMMIT_EVENT_ID = uuid(14);
const ATTEMPT_ID = ATTEMPT_CORRELATION.attempt_id;

/**
 * The signal for the held commit, caused by the caller timeout and the commit (sorted).
 *
 * @example
 * toJson(timeoutSignalRecorded());
 */
export function timeoutSignalRecorded(): TimeoutSignalRecorded {
  return {
    ...trialEnvelope('timeout_signal_recorded', 23, 1),
    source: 'treatment_controller',
    causation_event_ids: [CALLER_TIMEOUT_EVENT_ID, COMMIT_EVENT_ID],
    provider_commit_id: COMMIT_TRIPLE.provider_commit_id,
    attempt_id: ATTEMPT_ID,
    caller_timeout_event_id: CALLER_TIMEOUT_EVENT_ID,
    provider_commit_event_id: COMMIT_EVENT_ID,
  };
}

/**
 * A redelivery of the same caller timeout after the signal.
 *
 * @example
 * toJson(timeoutSignalDuplicateObserved());
 */
export function timeoutSignalDuplicateObserved(): TimeoutSignalDuplicateObserved {
  return {
    ...trialEnvelope('timeout_signal_duplicate_observed', 24, 2),
    source: 'treatment_controller',
    caller_timeout_event_id: CALLER_TIMEOUT_EVENT_ID,
    attempt_id: ATTEMPT_ID,
    treatment_state: 'TIMEOUT_SIGNALLED',
  };
}

/**
 * A different caller timeout for an already signalled treatment.
 *
 * @example
 * toJson(timeoutSignalConflictRecorded());
 */
export function timeoutSignalConflictRecorded(): TimeoutSignalConflictRecorded {
  return {
    ...trialEnvelope('timeout_signal_conflict_recorded', 25, 3),
    source: 'treatment_controller',
    caller_timeout_event_id: uuid(0x600),
    existing_caller_event_id: CALLER_TIMEOUT_EVENT_ID,
    attempt_id: ATTEMPT_ID,
    treatment_state: 'TIMEOUT_OBSERVED',
  };
}

/**
 * A caller timeout arriving after the safety release.
 *
 * @example
 * toJson(lateTimeoutSignalRejected());
 */
export function lateTimeoutSignalRejected(): LateTimeoutSignalRejected {
  return {
    ...trialEnvelope('late_timeout_signal_rejected', 26, 4),
    source: 'treatment_controller',
    caller_timeout_event_id: CALLER_TIMEOUT_EVENT_ID,
    attempt_id: ATTEMPT_ID,
    treatment_state: 'SAFETY_RELEASED',
  };
}

/**
 * A caller timeout for an attempt other than the committed target.
 *
 * @example
 * toJson(notTargetedCallerTimeout());
 */
export function notTargetedCallerTimeout(): NotTargetedCallerTimeout {
  return {
    ...trialEnvelope('caller_timeout_rejected', 27, 5),
    source: 'treatment_controller',
    reason: 'NOT_TARGETED',
    detail: 'attempt is not the committed target; expected the targeted attempt',
    caller_timeout_event_id: CALLER_TIMEOUT_EVENT_ID,
    attempt_id: uuid(0x601),
    treatment_state: 'COMMITTED_WAITING',
  };
}

/**
 * A caller timeout that arrived before any commit.
 *
 * @example
 * toJson(beforeCommitCallerTimeout());
 */
export function beforeCommitCallerTimeout(): BeforeCommitCallerTimeout {
  return {
    ...trialEnvelope('caller_timeout_rejected', 27, 5),
    source: 'treatment_controller',
    reason: 'BEFORE_COMMIT',
    detail: 'treatment is ARMED; expected COMMITTED_WAITING',
    caller_timeout_event_id: CALLER_TIMEOUT_EVENT_ID,
    attempt_id: ATTEMPT_ID,
    treatment_state: 'ARMED',
  };
}

/**
 * A caller timeout in a CONTROL trial, which has no treatment.
 *
 * @example
 * toJson(controlTrialCallerTimeout());
 */
export function controlTrialCallerTimeout(): ControlTrialCallerTimeout {
  return {
    ...trialEnvelope('caller_timeout_rejected', 27, 5),
    source: 'treatment_controller',
    reason: 'CONTROL_TRIAL',
    detail: 'trial scenario is CONTROL; expected COMMIT_THEN_TIMEOUT',
    caller_timeout_event_id: CALLER_TIMEOUT_EVENT_ID,
    attempt_id: ATTEMPT_ID,
  };
}

/**
 * A stream record the controller could not read as a caller timeout.
 *
 * @example
 * toJson(invalidCallerTimeout());
 */
export function invalidCallerTimeout(): InvalidCallerTimeout {
  return {
    ...trialEnvelope('caller_timeout_rejected', 27, 5),
    source: 'treatment_controller',
    reason: 'INVALID_EVENT',
    detail: 'elapsed_ns is absent; expected a canonical decimal',
    caller_timeout_event_id: CALLER_TIMEOUT_EVENT_ID,
    attempt_id: ATTEMPT_ID,
    treatment_state: 'COMMITTED_WAITING',
  };
}

/**
 * The controller's acknowledgement of a readiness canary (execution level).
 *
 * @example
 * toJson(controllerCanaryAcknowledged());
 */
export function controllerCanaryAcknowledged(): ControllerCanaryAcknowledged {
  return {
    ...executionEnvelope('controller_canary_acknowledged', 'run', 28, 6),
    source: 'treatment_controller',
    causation_event_ids: [uuid(0x602)],
    canary_event_id: uuid(0x602),
  };
}

export const CONTROLLER_EXAMPLES: readonly RecordExample[] = [
  example('timeout_signal_recorded', timeoutSignalRecorded()),
  example('timeout_signal_duplicate_observed', timeoutSignalDuplicateObserved()),
  example('timeout_signal_conflict_recorded', timeoutSignalConflictRecorded()),
  example('late_timeout_signal_rejected', lateTimeoutSignalRejected()),
  example('caller_timeout_rejected NOT_TARGETED', notTargetedCallerTimeout()),
  example('caller_timeout_rejected BEFORE_COMMIT', beforeCommitCallerTimeout()),
  example('caller_timeout_rejected CONTROL_TRIAL', controlTrialCallerTimeout()),
  example('caller_timeout_rejected INVALID_EVENT', invalidCallerTimeout(), {
    optional: ['caller_timeout_event_id', 'attempt_id', 'treatment_state'],
  }),
  example('controller_canary_acknowledged', controllerCanaryAcknowledged(), { optional: ['causation_event_ids'] }),
];
