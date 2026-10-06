// The twelve cleanup steps of BR-RUA-048 (design §10.4), their journal action names, the order
// each mode runs them in, and which steps a re-run repeats (AC-RUA-011).
//
// Emergency cleanup (BR-RUA-049) "stops publishers and consumers immediately", so it disables
// consumers (step 3) first, before the late-evidence steps 1 and 2, which it shortens or skips.
// The caller stops publishers before it starts emergency cleanup. The steps keep their BR-RUA-048
// numbers in either order.
//
// A re-run skips every step the cleanup journal shows as succeeded, except the audit steps 10
// and 11 and the freeze (step 12): an earlier audit describes an earlier moment, and the frozen
// result needs a current one, so it is frozen again with the new audit.

import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';

export const CLEANUP_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type CleanupStepNumber = (typeof CLEANUP_STEPS)[number];

/** The step-level journal action of each step: its start and its terminal status carry it. */
export const STEP_ACTIONS: Readonly<Record<CleanupStepNumber, string>> = {
  1: 'LATE_EVIDENCE_CUTOFF',
  2: 'LATE_ASSESSMENT_FREEZE',
  3: 'CONSUMERS_DISABLE',
  4: 'PRE_CLEANUP_SNAPSHOT',
  5: 'BARRIERS_RELEASE_AND_EXECUTIONS_STOP',
  6: 'CLEANUP_INDUCED_TRANSITIONS_RECORD',
  7: 'DLQ_EVIDENCE_CAPTURE',
  8: 'CAPTURED_DLQ_MESSAGES_DELETE',
  9: 'OWNED_RESOURCES_DELETE',
  10: 'DISCOVERY_SURFACES_AUDIT',
  11: 'STABLE_ABSENCE_CONFIRM',
  12: 'RESULTS_FREEZE',
};

/** Item-level journal actions, one per resource or message a step acted on. */
export const ITEM_ACTIONS = {
  consumerDisabled: 'CONSUMER_DISABLED',
  consumerAbsent: 'CONSUMER_ALREADY_ABSENT',
  consumerDisableFailed: 'CONSUMER_DISABLE_FAILED',
  safetyReleaseApplied: 'SAFETY_RELEASE_APPLIED',
  safetyReleaseNotHeld: 'SAFETY_RELEASE_NOT_HELD',
  safetyReleaseFailed: 'SAFETY_RELEASE_FAILED',
  durableListFailed: 'DURABLE_EXECUTIONS_LIST_FAILED',
  durableStopApplied: 'DURABLE_STOP_APPLIED',
  durableStopNotRunning: 'DURABLE_STOP_NOT_RUNNING',
  durableStopFailed: 'DURABLE_STOP_FAILED',
  treatmentSafetyReleased: 'TREATMENT_SAFETY_RELEASED',
  durableExecutionStopped: 'DURABLE_EXECUTION_STOPPED',
  dlqMessageCaptured: 'DLQ_MESSAGE_CAPTURED',
  dlqMessageDeleted: 'DLQ_MESSAGE_DELETED',
  dlqMessageAbsent: 'DLQ_MESSAGE_ALREADY_ABSENT',
  dlqMessageDeleteFailed: 'DLQ_MESSAGE_DELETE_FAILED',
} as const;

const NORMAL_ORDER: readonly CleanupStepNumber[] = CLEANUP_STEPS;
const EMERGENCY_ORDER: readonly CleanupStepNumber[] = [3, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const ALWAYS_RERUN: ReadonlySet<CleanupStepNumber> = new Set<CleanupStepNumber>([10, 11, 12]);

/**
 * The order a mode runs the steps in.
 *
 * @example
 * cleanupStepOrder('EMERGENCY').slice(0, 3); // [3, 1, 2]
 */
export function cleanupStepOrder(mode: CleanupMode): readonly CleanupStepNumber[] {
  return mode === 'NORMAL' ? NORMAL_ORDER : EMERGENCY_ORDER;
}

/**
 * Whether a run must execute `step`, given the steps the cleanup journal shows as succeeded.
 *
 * @example
 * mustRunStep(9, new Set([9])); // false: deletion already succeeded
 * mustRunStep(10, new Set([10])); // true: the audit always observes again
 * mustRunStep(12, new Set([12])); // true: the result is frozen again with the new audit
 */
export function mustRunStep(step: CleanupStepNumber, succeeded: ReadonlySet<number>): boolean {
  return ALWAYS_RERUN.has(step) || !succeeded.has(step);
}

/**
 * Narrows a journal `step` value to a step number.
 *
 * @example
 * isCleanupStep(12); // true
 * isCleanupStep(13); // false
 */
export function isCleanupStep(step: number): step is CleanupStepNumber {
  return (CLEANUP_STEPS as readonly number[]).includes(step);
}
