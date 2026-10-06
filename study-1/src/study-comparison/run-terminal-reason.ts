// The canonical run terminal reason (CTR-RUA-002; design §8.14) and the final lease status
// (BR-RUA-045; design §10.3). "The first specific causal condition that prevents clean completion
// remains primary": runner and lease events are read in journal time order, and the earliest one
// that stops the lifecycle (lease acquisition or loss, provisioning, readiness or trials, an
// interruption) wins. The closure conditions come after every trial by construction (phases P7 and
// P8 follow P1-P6, design §10.2), so they are judged next: a trial left unfrozen, then cleanup, then
// the leak audit, and last a failed summary phase. CTR-RUA-002 has no reason for a failed lease
// release; such a run ends `COMPLETED` with a lease status other than `released` (finding F12).

import type { LeaseEventRecorded } from '../record-contract/records/group-b/lease_event_recorded.ts';
import type { PhaseTransitionRecorded } from '../record-contract/records/group-b/phase_transition_recorded.ts';
import type { TrialInterrupted } from '../record-contract/records/group-b/trial_interrupted.ts';
import type { ExecutionPhase, LeaseEvent } from '../record-contract/records/group-b/vocabulary.ts';
import type {
  CleanupStatus,
  LeakAuditStatus,
  LeaseStatus,
  RunTerminalReason,
} from '../record-contract/records/group-c/vocabulary.ts';

/** The journal events a run's terminal reason is derived from (design §5.3 `RunnerEvent`). */
export type RunnerEvent = PhaseTransitionRecorded | TrialInterrupted | LeaseEventRecorded;

/** What the terminal reason reads besides the events: whether every trial froze, and the closure. */
export interface RunTerminalInput {
  /** Runner-journal and coordination-journal events, in any order. */
  readonly events: readonly RunnerEvent[];
  /** True when every declared trial froze an oracle result. */
  readonly all_trials_frozen: boolean;
  /** Absent when the cleanup result or the leak audit was never frozen. */
  readonly cleanup_status: CleanupStatus | undefined;
  readonly leak_audit_status: LeakAuditStatus | undefined;
}

/** A failed phase that stops the run before closure. */
const FAILED_PHASE_REASONS: Readonly<Partial<Record<ExecutionPhase, RunTerminalReason>>> = {
  LEASE_ACQUISITION: 'LEASE_ACQUISITION_FAILED',
  PROVISIONING: 'PROVISIONING_FAILED',
  READINESS: 'TRIAL_INCOMPLETE',
  TRIALS: 'TRIAL_INCOMPLETE',
};

/** A lease event that stops the run before closure. */
const LEASE_EVENT_REASONS: Readonly<Partial<Record<LeaseEvent, RunTerminalReason>>> = {
  ACQUISITION_FAILED: 'LEASE_ACQUISITION_FAILED',
  LOST_OWNERSHIP_MISMATCH: 'LEASE_LOST',
  LOST_STALE: 'LEASE_LOST',
};

/** The lease events that settle the final lease status (design §10.3 finalize transitions). */
const FINAL_LEASE_EVENTS: Readonly<Partial<Record<LeaseEvent, LeaseStatus>>> = {
  RELEASED: 'released',
  RECOVERY_REQUIRED: 'recovery_required',
  RELEASE_FAILED: 'unverified',
  STATE_UNVERIFIED: 'unverified',
};

/**
 * Derives the CTR-RUA-002 terminal reason of a run.
 *
 * @example
 * deriveRunTerminalReason({ events, all_trials_frozen: true, cleanup_status: 'succeeded', leak_audit_status: 'clean' }); // 'COMPLETED'
 */
export function deriveRunTerminalReason(input: RunTerminalInput): RunTerminalReason {
  const stopping = inTimeOrder(input.events)
    .map(stoppingReason)
    .find((reason) => reason !== undefined);
  if (stopping !== undefined) {
    return stopping;
  }
  if (!input.all_trials_frozen) {
    return 'TRIAL_INCOMPLETE';
  }
  if (input.cleanup_status !== 'succeeded') {
    return 'CLEANUP_INCOMPLETE';
  }
  if (input.leak_audit_status !== 'clean') {
    return 'LEAK_AUDIT_NOT_CLEAN';
  }
  const summaryFailed = input.events.some(
    (event) =>
      event.record_type === 'phase_transition_recorded' && event.phase === 'SUMMARY' && event.status === 'failed',
  );
  return summaryFailed ? 'EVIDENCE_FINALIZATION_FAILED' : 'COMPLETED';
}

/**
 * The BR-RUA-045 final lease status: the last release, recovery or unverified-state event decides;
 * with none of them the release was never established, so it is `unverified` (TTL expiry never
 * establishes release).
 *
 * @example
 * finalLeaseStatus(coordinationEvents); // 'released' after a conditional release succeeded
 */
export function finalLeaseStatus(events: readonly LeaseEventRecorded[]): LeaseStatus {
  const settled = inTimeOrder(events)
    .map((event) => FINAL_LEASE_EVENTS[event.lease_event])
    .filter((status) => status !== undefined);
  return settled.at(-1) ?? 'unverified';
}

function stoppingReason(event: RunnerEvent): RunTerminalReason | undefined {
  switch (event.record_type) {
    case 'phase_transition_recorded':
      return event.status === 'failed' ? FAILED_PHASE_REASONS[event.phase] : undefined;
    case 'trial_interrupted':
      return event.cause;
    case 'lease_event_recorded':
      return LEASE_EVENT_REASONS[event.lease_event];
  }
}

// Stable sort by `occurred_at`: the fixed-width UTC millisecond form orders lexically, and events
// with the same instant keep their journal order.
function inTimeOrder<T extends { readonly occurred_at: string }>(events: readonly T[]): readonly T[] {
  return events.toSorted((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0));
}
