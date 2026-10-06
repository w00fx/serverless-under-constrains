// Runner and coordination-lease journal events of one variant validation, for the terminal-reason
// tests. Each builder returns a complete, typed event of the validation scope.

import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import type { LeaseEventRecorded } from '../../../../src/record-contract/records/group-b/lease_event_recorded.ts';
import type { PhaseTransitionRecorded } from '../../../../src/record-contract/records/group-b/phase_transition_recorded.ts';
import type { SafetyCheckRecorded } from '../../../../src/record-contract/records/group-b/safety_check_recorded.ts';
import type { TrialInterrupted } from '../../../../src/record-contract/records/group-b/trial_interrupted.ts';
import type {
  ExecutionPhase,
  InterruptionCause,
  LeaseEvent,
  SafetyBoundary,
  SafetyResult,
  StepStatus,
} from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import {
  EXECUTION_MANIFEST_SHA256,
  TRIAL_SCOPE,
  VALIDATION_ID,
  at,
  executionEnvelope,
} from '../../../support/record-contract/record-builders.ts';

let eventNumber = 0x1800;

// Each event gets the next event id and source sequence, so a journal of them is ordered.
function nextNumber(): number {
  eventNumber += 1;
  return eventNumber;
}

/**
 * A runner phase transition.
 *
 * @example
 * phaseEvent('CLEANUP', 'failed');
 */
export function phaseEvent(phase: ExecutionPhase, status: StepStatus): PhaseTransitionRecorded {
  return {
    ...executionEnvelope('phase_transition_recorded', 'validation', nextNumber(), eventNumber),
    source: 'runner',
    phase,
    status,
    reasons: [],
  };
}

/**
 * A trial interruption with its cause.
 *
 * @example
 * interruptedEvent('OPERATOR_ABORT');
 */
export function interruptedEvent(cause: InterruptionCause): TrialInterrupted {
  return {
    ...executionEnvelope('trial_interrupted', 'validation', nextNumber(), eventNumber),
    ...TRIAL_SCOPE,
    source: 'runner',
    cause,
    detail: `interrupted: ${cause}`,
  };
}

/**
 * A runner safety check.
 *
 * @example
 * safetyEvent('ACTIVE_TIME', 'breached');
 */
export function safetyEvent(boundary: SafetyBoundary, result: SafetyResult): SafetyCheckRecorded {
  return {
    ...executionEnvelope('safety_check_recorded', 'validation', nextNumber(), eventNumber),
    source: 'runner',
    boundary,
    declared_limit: '4500000 ms',
    observed: '4600000 ms',
    result,
    evidence_refs: [],
    checked_at: at(4000),
  };
}

/**
 * A coordination-lease event of this validation.
 *
 * @example
 * leaseEvent('RELEASE_FAILED');
 */
export function leaseEvent(event: LeaseEvent): LeaseEventRecorded {
  const owner: Uuid4 = VALIDATION_ID;
  return {
    ...executionEnvelope('lease_event_recorded', 'validation', nextNumber(), eventNumber),
    source: 'coordination_lease',
    lease_event: event,
    owner_kind: 'VARIANT_VALIDATION',
    owner_id: owner,
    owner_manifest_sha256: EXECUTION_MANIFEST_SHA256,
  };
}
