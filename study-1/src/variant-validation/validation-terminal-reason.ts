// The canonical validation terminal reason (BR-RUA-038; design §6.3, §10.2, §10.3): the earliest
// causal condition of the lifecycle, or `COMPLETED` when none occurred. The runner journal and the
// coordination journal give the execution-time causes in journal order; the frozen closure gives
// cleanup and leak-audit closure (phase P7); lease finalization (phase P8) comes last.
//
// Lifecycle phases and events map onto the BR-RUA-038 set as follows:
// - P1 lease acquisition failed, or the lease event ACQUISITION_FAILED: LEASE_ACQUISITION_FAILED;
// - P2 provisioning failed: PROVISIONING_FAILED;
// - P3 readiness or P4 trials failed (a trial could not start or be frozen, D-29): VALIDATION_INCOMPLETE;
// - a trial interruption: its cause (LEASE_LOST, OPERATOR_ABORT, SAFETY_DEADLINE, INTERRUPTED);
// - a lost lease (ownership mismatch or stale): LEASE_LOST;
// - a breached safety check: SAFETY_DEADLINE for the active-time boundary (the safety deadline of
//   BR-RUA-046), SAFETY_LIMIT_EXCEEDED for any other boundary;
// - P5 freeze or P9 summary failed: EVIDENCE_FINALIZATION_FAILED;
// - P7 cleanup failed, or a non-succeeded cleanup: CLEANUP_INCOMPLETE; a non-clean audit:
//   LEAK_AUDIT_NOT_CLEAN;
// - P8 finalization failed or the lease state is unverified: LEASE_STATE_UNVERIFIED; a failed
//   release, or a final `recovery_required` lease: LEASE_RELEASE_FAILED.
// P6 late monitoring has no terminal reason: its failure makes late evidence `unverified`, which
// the status judges separately (BR-RUA-043).

import type { OriginalClosure } from '../evidence-package/effective-operational-state.ts';
import type { LeaseEventRecorded } from '../record-contract/records/group-b/lease_event_recorded.ts';
import type { PhaseTransitionRecorded } from '../record-contract/records/group-b/phase_transition_recorded.ts';
import type { SafetyCheckRecorded } from '../record-contract/records/group-b/safety_check_recorded.ts';
import type { TrialInterrupted } from '../record-contract/records/group-b/trial_interrupted.ts';
import type { ExecutionPhase, LeaseEvent } from '../record-contract/records/group-b/vocabulary.ts';
import type { ValidationTerminalReason } from '../record-contract/records/group-c/vocabulary.ts';

/** The journal events that can end a validation lifecycle, in journal order. */
export type ValidationLifecycleEvent =
  PhaseTransitionRecorded | TrialInterrupted | SafetyCheckRecorded | LeaseEventRecorded;

const FAILED_PHASE_REASONS: Readonly<Record<ExecutionPhase, ValidationTerminalReason | undefined>> = {
  LEASE_ACQUISITION: 'LEASE_ACQUISITION_FAILED',
  PROVISIONING: 'PROVISIONING_FAILED',
  READINESS: 'VALIDATION_INCOMPLETE',
  TRIALS: 'VALIDATION_INCOMPLETE',
  PROBE_FREEZE: 'EVIDENCE_FINALIZATION_FAILED',
  LATE_MONITORING: undefined,
  CLEANUP: 'CLEANUP_INCOMPLETE',
  LEASE_FINALIZATION: 'LEASE_STATE_UNVERIFIED',
  SUMMARY: 'EVIDENCE_FINALIZATION_FAILED',
};

const LEASE_EVENT_REASONS: Readonly<Record<LeaseEvent, ValidationTerminalReason | undefined>> = {
  ACQUIRED: undefined,
  ACQUISITION_FAILED: 'LEASE_ACQUISITION_FAILED',
  HEARTBEAT_CONFIRMED: undefined,
  // Uncertainty alone is no terminal cause: it is recovered or becomes a loss (BR-RUA-045).
  HEARTBEAT_FAILED: undefined,
  RECOVERED: undefined,
  LOST_OWNERSHIP_MISMATCH: 'LEASE_LOST',
  LOST_STALE: 'LEASE_LOST',
  RELEASED: undefined,
  RELEASE_FAILED: 'LEASE_RELEASE_FAILED',
  // A consequence of an unclean closure, whose own cause is reported instead.
  RECOVERY_REQUIRED: undefined,
  STATE_UNVERIFIED: 'LEASE_STATE_UNVERIFIED',
};

/** The causes that arise only at lease finalization, after cleanup and the audit closed. */
const FINALIZATION_REASONS: ReadonlySet<ValidationTerminalReason> = new Set([
  'LEASE_RELEASE_FAILED',
  'LEASE_STATE_UNVERIFIED',
]);

/**
 * The validation terminal reason of a lifecycle.
 *
 * @example
 * deriveValidationTerminalReason(runnerAndLeaseEvents, { cleanup_status: 'succeeded',
 *   leak_audit_status: 'clean', lease_status: 'released' }); // 'COMPLETED' when nothing failed
 */
export function deriveValidationTerminalReason(
  events: readonly ValidationLifecycleEvent[],
  closure: OriginalClosure,
): ValidationTerminalReason {
  const causes = events.map(causeOf).filter((cause): cause is ValidationTerminalReason => cause !== undefined);
  const executionCause = causes.find((cause) => !FINALIZATION_REASONS.has(cause));
  const closureCause = closureCauseOf(closure);
  const finalizationCause = causes.find((cause) => FINALIZATION_REASONS.has(cause));
  return executionCause ?? closureCause ?? finalizationCause ?? leaseCauseOf(closure) ?? 'COMPLETED';
}

function causeOf(event: ValidationLifecycleEvent): ValidationTerminalReason | undefined {
  switch (event.record_type) {
    case 'phase_transition_recorded':
      return event.status === 'failed' ? FAILED_PHASE_REASONS[event.phase] : undefined;
    case 'trial_interrupted':
      return event.cause;
    case 'safety_check_recorded':
      return safetyCauseOf(event);
    case 'lease_event_recorded':
      return LEASE_EVENT_REASONS[event.lease_event];
  }
}

function safetyCauseOf(event: SafetyCheckRecorded): ValidationTerminalReason | undefined {
  if (event.result !== 'breached') {
    return undefined;
  }
  return event.boundary === 'ACTIVE_TIME' ? 'SAFETY_DEADLINE' : 'SAFETY_LIMIT_EXCEEDED';
}

function closureCauseOf(closure: OriginalClosure): ValidationTerminalReason | undefined {
  if (closure.cleanup_status !== 'succeeded') {
    return 'CLEANUP_INCOMPLETE';
  }
  return closure.leak_audit_status === 'clean' ? undefined : 'LEAK_AUDIT_NOT_CLEAN';
}

function leaseCauseOf(closure: OriginalClosure): ValidationTerminalReason | undefined {
  switch (closure.lease_status) {
    case 'released':
      return undefined;
    case 'recovery_required':
      return 'LEASE_RELEASE_FAILED';
    case 'unverified':
      return 'LEASE_STATE_UNVERIFIED';
  }
}
