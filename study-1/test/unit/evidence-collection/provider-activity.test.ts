// Provider activity derived from the provider journal and the treatment item (design §9.3; BR-RUA-032).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveProviderActivity,
  TERMINAL_PROVIDER_EVENTS,
} from '../../../src/evidence-collection/provider-activity.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';

const CALL_A = '00000000-0000-4000-8000-00000000c001';
const CALL_B = '00000000-0000-4000-8000-00000000c002';

const event = (recordType: string, callId?: string): JsonObject => ({
  record_type: recordType,
  ...(callId === undefined ? {} : { provider_call_id: callId }),
});

describe('deriveProviderActivity', () => {
  it('counts a call active from its receipt until a terminal provider event', () => {
    assert.deepEqual(deriveProviderActivity([event('provider_call_received', CALL_A)], undefined), {
      active_calls: 1,
      held_barriers: 0,
      pending_releases: 0,
    });
    assert.equal(
      deriveProviderActivity(
        [event('provider_call_received', CALL_A), event('provider_call_accepted', CALL_A)],
        undefined,
      ).active_calls,
      1,
    );
  });

  it('closes a call on every terminal provider event (design §9.3)', () => {
    assert.deepEqual(TERMINAL_PROVIDER_EVENTS, [
      'provider_call_rejected',
      'provider_response_returned',
      'provider_commit_failed',
      'treatment_response_released',
      'treatment_safety_released',
    ]);
    for (const terminal of TERMINAL_PROVIDER_EVENTS) {
      const events = [
        event('provider_call_received', CALL_A),
        event(terminal, CALL_A),
        event('provider_call_received', CALL_B),
      ];
      assert.equal(deriveProviderActivity(events, undefined).active_calls, 1, terminal);
    }
  });

  it('ignores an armed safety release, which names no call', () => {
    const events = [event('provider_call_received', CALL_A), event('treatment_safety_released')];
    assert.equal(deriveProviderActivity(events, undefined).active_calls, 1);
  });

  it('counts a held barrier in COMMITTED_WAITING and TIMEOUT_SIGNALLED, a pending release in TIMEOUT_OBSERVED', () => {
    const states: readonly [string, number, number][] = [
      ['ARMED', 0, 0],
      ['COMMITTED_WAITING', 1, 0],
      ['TIMEOUT_SIGNALLED', 1, 0],
      ['TIMEOUT_OBSERVED', 0, 1],
      ['RESPONSE_RELEASED', 0, 0],
      ['SAFETY_RELEASED', 0, 0],
    ];
    for (const [state, held, pending] of states) {
      const activity = deriveProviderActivity([], { state, version: 2 });
      assert.deepEqual([activity.held_barriers, activity.pending_releases], [held, pending], state);
    }
  });

  it('reads only own string members of untrusted rows (A-05)', () => {
    const hostile = JSON.parse(
      '[{"record_type":{"toString":"x"},"provider_call_id":"a"},{"provider_call_id":7},{"__proto__":{"provider_call_id":"b"}}]',
    ) as JsonObject[];
    assert.equal(deriveProviderActivity(hostile, { state: { toString: 'COMMITTED_WAITING' } }).active_calls, 1);
    assert.equal(deriveProviderActivity([], { state: { toString: 'x' } }).held_barriers, 0);
    assert.equal(
      deriveProviderActivity([], Object.create({ state: 'TIMEOUT_OBSERVED' }) as JsonObject).pending_releases,
      0,
    );
  });
});
