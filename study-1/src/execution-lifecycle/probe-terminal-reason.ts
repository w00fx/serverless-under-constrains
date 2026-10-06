// The transport probe terminal reason (CTR-RUA-003; design §10.2) with the probe-result digest it
// carries. Like a run's (study-comparison/run-terminal-reason.ts), the first specific causal
// condition that prevents clean completion stays primary: runner and lease events are read in
// journal time order and the earliest one that stops the lifecycle wins (lease acquisition or loss,
// provisioning, readiness or the probe workload P4, the freeze P5, an interruption). The closure
// conditions follow P5 by construction, so they are judged next: no frozen probe result, then
// cleanup, then the leak audit, and last a failed summary phase.
//
// The digest of `probe/derived/transport-probe-result.json` is carried whenever P5 froze the result
// (the result and the probe evidence index are both stored): it is required with the post-freeze
// reasons, which by this order arise only with a frozen result, and BR-RUA-033 omits it otherwise.

import type { Sha256Hex } from '../record-contract/primitives.ts';
import type { ExecutionPhase, LeaseEvent } from '../record-contract/records/group-b/vocabulary.ts';
import type { ProbeResultDigest } from '../record-contract/records/group-c/transport_probe_summary.ts';
import type {
  CleanupStatus,
  LeakAuditStatus,
  PostFreezeProbeTerminalReason,
  ProbeTerminalReason,
} from '../record-contract/records/group-c/vocabulary.ts';
import type { RunnerEvent } from '../study-comparison/run-terminal-reason.ts';
import { inJournalTime } from './closure-records.ts';

/** What the probe terminal reason reads. */
export interface ProbeTerminalInput {
  /** Runner-journal and coordination-journal events, in any order. */
  readonly events: readonly RunnerEvent[];
  /** The digest of the frozen probe result; undefined when P5 froze none. */
  readonly probe_result_sha256: Sha256Hex | undefined;
  /** Absent when the cleanup result or the leak audit was never frozen. */
  readonly cleanup_status: CleanupStatus | undefined;
  readonly leak_audit_status: LeakAuditStatus | undefined;
}

/** A reason that can stop the probe before P5 froze its result, or without one. */
type StoppingReason = Exclude<ProbeTerminalReason, PostFreezeProbeTerminalReason>;

/** A failed phase that stops the probe before closure. */
const FAILED_PHASE_REASONS: Readonly<Partial<Record<ExecutionPhase, StoppingReason>>> = {
  LEASE_ACQUISITION: 'LEASE_ACQUISITION_FAILED',
  PROVISIONING: 'PROVISIONING_FAILED',
  READINESS: 'PROBE_INCOMPLETE',
  TRIALS: 'PROBE_INCOMPLETE',
  PROBE_FREEZE: 'EVIDENCE_FINALIZATION_FAILED',
};

/** A lease event that stops the probe before closure. */
const LEASE_EVENT_REASONS: Readonly<Partial<Record<LeaseEvent, StoppingReason>>> = {
  ACQUISITION_FAILED: 'LEASE_ACQUISITION_FAILED',
  LOST_OWNERSHIP_MISMATCH: 'LEASE_LOST',
  LOST_STALE: 'LEASE_LOST',
};

/**
 * Derives the CTR-RUA-003 terminal reason of a probe, with the frozen result's digest when there is one.
 *
 * @example
 * deriveProbeTerminalReason({ events, probe_result_sha256: digest, cleanup_status: 'succeeded',
 *   leak_audit_status: 'clean' }); // { probe_terminal_reason: 'COMPLETED', probe_result_sha256: digest }
 */
export function deriveProbeTerminalReason(input: ProbeTerminalInput): ProbeResultDigest {
  const digest = input.probe_result_sha256;
  const carried = digest === undefined ? {} : { probe_result_sha256: digest };
  const stopping = inJournalTime(input.events)
    .map(stoppingReason)
    .find((reason) => reason !== undefined);
  if (stopping !== undefined) {
    return { probe_terminal_reason: stopping, ...carried };
  }
  if (digest === undefined) {
    return { probe_terminal_reason: 'PROBE_INCOMPLETE' };
  }
  if (input.cleanup_status !== 'succeeded') {
    return { probe_terminal_reason: 'CLEANUP_INCOMPLETE', probe_result_sha256: digest };
  }
  if (input.leak_audit_status !== 'clean') {
    return { probe_terminal_reason: 'LEAK_AUDIT_NOT_CLEAN', probe_result_sha256: digest };
  }
  const summaryFailed = input.events.some(
    (event) =>
      event.record_type === 'phase_transition_recorded' && event.phase === 'SUMMARY' && event.status === 'failed',
  );
  return summaryFailed
    ? { probe_terminal_reason: 'EVIDENCE_FINALIZATION_FAILED', probe_result_sha256: digest }
    : { probe_terminal_reason: 'COMPLETED', probe_result_sha256: digest };
}

function stoppingReason(event: RunnerEvent): StoppingReason | undefined {
  switch (event.record_type) {
    case 'phase_transition_recorded':
      return event.status === 'failed' ? FAILED_PHASE_REASONS[event.phase] : undefined;
    case 'trial_interrupted':
      return event.cause;
    case 'lease_event_recorded':
      return LEASE_EVENT_REASONS[event.lease_event];
  }
}
