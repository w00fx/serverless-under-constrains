// What the treatment barrier does next after one consistent read of the treatment item
// (BR-RUA-025, BR-RUA-013, BR-RUA-014, OR-RUA-002). The targeted call holds its response at
// the barrier until the controller signal arrives; the provider observes the signal, then
// releases immediately before returning. A wait still unsignalled 15 s after the commit was
// acknowledged ends in a safety release. A treatment that another writer already
// safety-released (cleanup's conditional request, design §10.4 step 5) ends the wait too.
//
// Precedence: a signal that is present is observed even when the safety deadline has passed,
// because the signal arrived before the provider released; the controller rejects only
// signals that arrive after a safety release.

import type { Uuid4 } from '../record-contract/primitives.ts';
import type { TreatmentItem } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import type { SafetyReleaseCause, TreatmentState } from '../record-contract/records/group-b/vocabulary.ts';

/** The nonterminal states a committed wait can be in (BR-RUA-025 "from any nonterminal wait"). */
export const COMMITTED_WAIT_STATES = ['COMMITTED_WAITING', 'TIMEOUT_SIGNALLED', 'TIMEOUT_OBSERVED'] as const;
export type CommittedWaitState = (typeof COMMITTED_WAIT_STATES)[number];

export type BarrierStep =
  | { readonly kind: 'observe'; readonly signal_event_id: Uuid4 }
  | { readonly kind: 'release'; readonly observed_event_id: Uuid4 }
  | { readonly kind: 'safety_release'; readonly from_state: CommittedWaitState }
  | { readonly kind: 'externally_released'; readonly cause: SafetyReleaseCause }
  | { readonly kind: 'keep_waiting' }
  | { readonly kind: 'unexpected_state'; readonly detail: string };

/**
 * Decides the barrier's next step for the commit `ownCommitId`. `treatment` is undefined when
 * the read failed; the wait then continues until the safety deadline, when a conditional
 * safety release from `COMMITTED_WAITING` settles what the state really is.
 *
 * @example
 * decideBarrierStep({ state: 'TIMEOUT_SIGNALLED', version: 3, provider_commit_id, signal_event_id }, provider_commit_id, 1_000_000_000n, 15_000_000_000n);
 * // { kind: 'observe', signal_event_id }
 */
export function decideBarrierStep(
  treatment: TreatmentItem | undefined,
  ownCommitId: Uuid4,
  elapsedSinceCommitNs: bigint,
  safetyReleaseNs: bigint,
): BarrierStep {
  const deadlinePassed = elapsedSinceCommitNs >= safetyReleaseNs;
  if (treatment === undefined) {
    return deadlinePassed ? { kind: 'safety_release', from_state: 'COMMITTED_WAITING' } : { kind: 'keep_waiting' };
  }
  if (treatment.provider_commit_id !== ownCommitId) {
    return unexpected(treatment, ownCommitId);
  }
  switch (treatment.state) {
    case 'TIMEOUT_SIGNALLED':
      return signalledStep(treatment, deadlinePassed);
    case 'TIMEOUT_OBSERVED':
      return observedStep(treatment, ownCommitId);
    case 'COMMITTED_WAITING':
      return deadlinePassed ? { kind: 'safety_release', from_state: 'COMMITTED_WAITING' } : { kind: 'keep_waiting' };
    case 'SAFETY_RELEASED':
      // Another writer released the wait; a release without a recorded cause came from cleanup.
      return { kind: 'externally_released', cause: treatment.safety_release_cause ?? 'CLEANUP_REQUEST' };
    case 'ARMED':
    case 'RESPONSE_RELEASED':
      return unexpected(treatment, ownCommitId);
  }
}

/**
 * Whether a treatment state is a committed wait.
 *
 * @example
 * isCommittedWaitState('TIMEOUT_SIGNALLED'); // true
 * isCommittedWaitState('ARMED'); // false
 */
export function isCommittedWaitState(state: TreatmentState | undefined): state is CommittedWaitState {
  return (COMMITTED_WAIT_STATES as readonly (TreatmentState | undefined)[]).includes(state);
}

function signalledStep(treatment: TreatmentItem, deadlinePassed: boolean): BarrierStep {
  if (treatment.signal_event_id !== undefined) {
    return { kind: 'observe', signal_event_id: treatment.signal_event_id };
  }
  // A signal state without the signal identity cannot be observed causally (BR-RUA-013).
  return deadlinePassed ? { kind: 'safety_release', from_state: 'TIMEOUT_SIGNALLED' } : { kind: 'keep_waiting' };
}

function observedStep(treatment: TreatmentItem, ownCommitId: Uuid4): BarrierStep {
  if (treatment.observed_event_id === undefined) {
    return unexpected(treatment, ownCommitId);
  }
  return { kind: 'release', observed_event_id: treatment.observed_event_id };
}

function unexpected(treatment: TreatmentItem, ownCommitId: Uuid4): BarrierStep {
  return {
    kind: 'unexpected_state',
    detail:
      `treatment ${treatment.state} for commit ${treatment.provider_commit_id ?? 'none'}; expected a wait owned by ` +
      `commit ${ownCommitId} in COMMITTED_WAITING, TIMEOUT_SIGNALLED, TIMEOUT_OBSERVED or SAFETY_RELEASED`,
  };
}
