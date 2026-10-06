// The terminal BR-RUA-051 statuses of one cleanup (design §8.18).
//
// `cleanup_status` judges the deletion phase (step 9):
// - `partial`: some owned resource could not be deleted (`DELETE_FAILED`), whatever else happened;
// - `succeeded`: step 9 completed, so every owned resource it found is deleted or already absent
//   (an absent owned resource counts as deleted, AC-RUA-011);
// - `failed`: step 9 did not complete without a failed deletion: it never ran, was cut short, or
//   could not decide what to delete (the stack API or a discovery surface failed).
//
// `leak_audit_status` judges the audit passes (step 10-11):
// - `inconclusive`: fewer than two passes, any failed surface query, or any ambiguous resource
//   ("Any required query failure makes the audit inconclusive");
// - `leaks_detected`: otherwise, when any pass still observed an owned resource;
// - `clean`: otherwise, when the two passes are at least 120 s apart ("stable absence across
//   every applicable surface for 120 seconds"). A shorter interval proves no stability, so it is
//   `inconclusive`; the leak auditor never records two passes that close.

import type { AuditPass } from '../record-contract/records/group-c/leak_audit_result.ts';
import type { CleanupResource } from '../record-contract/records/group-c/cleanup_result.ts';
import type { StepStatus } from '../record-contract/records/group-b/vocabulary.ts';
import type { LeakAuditStatus, TerminalCleanupStatus } from '../record-contract/records/group-c/vocabulary.ts';

/** BR-RUA-051: clean status needs stable absence for 120 seconds. */
export const STABLE_ABSENCE_MS = 120_000;
/** Clean status needs two complete, successful, absent passes (design §9.14). */
export const REQUIRED_AUDIT_PASSES = 2;

export interface DeletionPhase {
  /** The latest status cleanup recorded for step 9, or undefined when step 9 never started. */
  readonly step9_status: StepStatus | undefined;
  readonly resources: readonly Pick<CleanupResource, 'action'>[];
}

/**
 * The cleanup status of one deletion phase.
 *
 * @example
 * deriveCleanupStatus({ step9_status: 'succeeded', resources: [{ action: 'ALREADY_ABSENT' }] }); // 'succeeded'
 * deriveCleanupStatus({ step9_status: 'failed', resources: [{ action: 'DELETE_FAILED' }] }); // 'partial'
 */
export function deriveCleanupStatus(phase: DeletionPhase): TerminalCleanupStatus {
  if (phase.resources.some((resource) => resource.action === 'DELETE_FAILED')) {
    return 'partial';
  }
  return phase.step9_status === 'succeeded' ? 'succeeded' : 'failed';
}

export interface AuditFacts {
  readonly passes: readonly AuditPass[];
  readonly leak_count: number;
  readonly ambiguous_count: number;
  readonly stable_absence_interval_ms: number;
}

/**
 * The leak-audit status of a set of audit passes.
 *
 * @example
 * deriveLeakAuditStatus({ passes: [first, second], leak_count: 0, ambiguous_count: 0, stable_absence_interval_ms: 120000 }); // 'clean'
 */
export function deriveLeakAuditStatus(facts: AuditFacts): LeakAuditStatus {
  const queriesFailed = facts.passes.some((pass) => pass.surfaces.some((surface) => !surface.query_ok));
  if (facts.passes.length < REQUIRED_AUDIT_PASSES || queriesFailed || facts.ambiguous_count > 0) {
    return 'inconclusive';
  }
  const observed = facts.passes.some((pass) => pass.surfaces.some((surface) => surface.observed.length > 0));
  if (observed || facts.leak_count > 0) {
    return 'leaks_detected';
  }
  return facts.stable_absence_interval_ms >= STABLE_ABSENCE_MS ? 'clean' : 'inconclusive';
}
