// Provider activity for settlement and the pre-cleanup snapshot (design §9.3, §5.3
// `deriveProviderActivity`; BR-RUA-032). The provider has no live activity counter: activity is
// derived from what it journaled and from the treatment item.
// - A call is active from the first provider event that names its `provider_call_id`
//   (`provider_call_received`) until a terminal provider event names it: `provider_call_rejected`,
//   `provider_response_returned`, `provider_commit_failed`, `treatment_response_released`, or
//   `treatment_safety_released` released from a committed state (only that variant names a call).
// - A barrier is held while the treatment is COMMITTED_WAITING or TIMEOUT_SIGNALLED.
// - A release is pending while the treatment is TIMEOUT_OBSERVED.
// Events are untrusted journal rows (A-05): only own string members are read, and a row without a
// call id names no call.

import type { JsonObject } from '../record-contract/primitives.ts';
import { ownValue } from './sdk-values.ts';

/** The three activity counts a settlement sample and the pre-cleanup snapshot carry. */
export interface ProviderActivity {
  readonly active_calls: number;
  readonly held_barriers: number;
  readonly pending_releases: number;
}

/** Provider events after which the call they name is no longer active (design §9.3). */
export const TERMINAL_PROVIDER_EVENTS: readonly string[] = [
  'provider_call_rejected',
  'provider_response_returned',
  'provider_commit_failed',
  'treatment_response_released',
  'treatment_safety_released',
];

const HELD_BARRIER_STATES: readonly string[] = ['COMMITTED_WAITING', 'TIMEOUT_SIGNALLED'];
const PENDING_RELEASE_STATE = 'TIMEOUT_OBSERVED';

/**
 * Derives the provider activity of one partition from its provider journal and treatment item.
 *
 * @example
 * deriveProviderActivity([received, accepted], { state: 'COMMITTED_WAITING', version: 2 });
 * // { active_calls: 1, held_barriers: 1, pending_releases: 0 }
 */
export function deriveProviderActivity(
  providerEvents: readonly JsonObject[],
  treatment: JsonObject | undefined,
): ProviderActivity {
  const opened = new Set<string>();
  const closed = new Set<string>();
  for (const event of providerEvents) {
    const callId = ownValue(event, 'provider_call_id');
    if (typeof callId !== 'string') {
      continue;
    }
    opened.add(callId);
    if (isOneOf(ownValue(event, 'record_type'), TERMINAL_PROVIDER_EVENTS)) {
      closed.add(callId);
    }
  }
  const state = ownValue(treatment, 'state');
  return {
    active_calls: [...opened].filter((callId) => !closed.has(callId)).length,
    held_barriers: isOneOf(state, HELD_BARRIER_STATES) ? 1 : 0,
    pending_releases: state === PENDING_RELEASE_STATE ? 1 : 0,
  };
}

// Never String(value): a parsed object with an own `toString` member makes that throw (A-05).
function isOneOf(value: unknown, members: readonly string[]): boolean {
  return typeof value === 'string' && members.includes(value);
}
