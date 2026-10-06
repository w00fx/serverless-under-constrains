// `decideBarrierStep` (BR-RUA-025, BR-RUA-013, BR-RUA-014, OR-RUA-002): observe a present
// signal, release after the observation, safety-release an unsignalled wait at exactly 15 s
// after the commit, end the wait when another writer safety-released it, and refuse a state
// that a wait owned by this commit can never be in.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { TreatmentItem } from '../../../src/record-contract/records/group-b/treatment_state_snapshot.ts';
import { decideBarrierStep, isCommittedWaitState } from '../../../src/refund-provider/barrier-decision.ts';
import { SIGNAL_EVENT_ID } from '../../support/refund-provider/provider-fixtures.ts';

const COMMIT = '44444444-0000-4000-8000-000000000001' as Uuid4;
const OTHER_COMMIT = '44444444-0000-4000-8000-000000000002' as Uuid4;
const OBSERVED = '44444444-0000-4000-8000-000000000003' as Uuid4;
const SAFETY = 15_000_000_000n;
const BEFORE = SAFETY - 1n;

function item(state: TreatmentItem['state'], extra: Partial<TreatmentItem> = {}): TreatmentItem {
  return { state, version: 2, provider_commit_id: COMMIT, ...extra };
}

describe('decideBarrierStep', () => {
  it('keeps waiting in COMMITTED_WAITING until exactly the safety deadline, then safety-releases', () => {
    assert.deepEqual(decideBarrierStep(item('COMMITTED_WAITING'), COMMIT, BEFORE, SAFETY), { kind: 'keep_waiting' });
    assert.deepEqual(decideBarrierStep(item('COMMITTED_WAITING'), COMMIT, SAFETY, SAFETY), {
      kind: 'safety_release',
      from_state: 'COMMITTED_WAITING',
    });
  });

  it('observes a present signal, even past the safety deadline', () => {
    const signalled = item('TIMEOUT_SIGNALLED', { signal_event_id: SIGNAL_EVENT_ID });
    for (const elapsed of [0n, BEFORE, SAFETY, SAFETY * 2n]) {
      assert.deepEqual(decideBarrierStep(signalled, COMMIT, elapsed, SAFETY), {
        kind: 'observe',
        signal_event_id: SIGNAL_EVENT_ID,
      });
    }
  });

  it('cannot observe a signal state without the signal identity: waits, then safety-releases', () => {
    const anonymous = item('TIMEOUT_SIGNALLED');
    assert.deepEqual(decideBarrierStep(anonymous, COMMIT, BEFORE, SAFETY), { kind: 'keep_waiting' });
    assert.deepEqual(decideBarrierStep(anonymous, COMMIT, SAFETY, SAFETY), {
      kind: 'safety_release',
      from_state: 'TIMEOUT_SIGNALLED',
    });
  });

  it('releases after an observation, naming the observation event', () => {
    assert.deepEqual(
      decideBarrierStep(item('TIMEOUT_OBSERVED', { observed_event_id: OBSERVED }), COMMIT, SAFETY, SAFETY),
      {
        kind: 'release',
        observed_event_id: OBSERVED,
      },
    );
  });

  it('ends the wait when another writer safety-released it, defaulting the cause to cleanup', () => {
    assert.deepEqual(decideBarrierStep(item('SAFETY_RELEASED'), COMMIT, 0n, SAFETY), {
      kind: 'externally_released',
      cause: 'CLEANUP_REQUEST',
    });
    assert.deepEqual(
      decideBarrierStep(item('SAFETY_RELEASED', { safety_release_cause: 'SAFETY_DEADLINE' }), COMMIT, 0n, SAFETY),
      { kind: 'externally_released', cause: 'SAFETY_DEADLINE' },
    );
  });

  it('without a readable item, waits until the deadline and then attempts a conditional safety release', () => {
    assert.deepEqual(decideBarrierStep(undefined, COMMIT, BEFORE, SAFETY), { kind: 'keep_waiting' });
    assert.deepEqual(decideBarrierStep(undefined, COMMIT, SAFETY, SAFETY), {
      kind: 'safety_release',
      from_state: 'COMMITTED_WAITING',
    });
  });

  it('refuses states a wait owned by this commit can never be in', () => {
    const expected = (state: string, commit: string): string =>
      `treatment ${state} for commit ${commit}; expected a wait owned by commit ${COMMIT} in COMMITTED_WAITING, ` +
      'TIMEOUT_SIGNALLED, TIMEOUT_OBSERVED or SAFETY_RELEASED';
    assert.deepEqual(decideBarrierStep(item('ARMED'), COMMIT, 0n, SAFETY), {
      kind: 'unexpected_state',
      detail: expected('ARMED', COMMIT),
    });
    assert.deepEqual(decideBarrierStep(item('RESPONSE_RELEASED'), COMMIT, 0n, SAFETY), {
      kind: 'unexpected_state',
      detail: expected('RESPONSE_RELEASED', COMMIT),
    });
    assert.deepEqual(decideBarrierStep(item('TIMEOUT_OBSERVED'), COMMIT, 0n, SAFETY), {
      kind: 'unexpected_state',
      detail: expected('TIMEOUT_OBSERVED', COMMIT),
    });
    assert.deepEqual(
      decideBarrierStep(item('COMMITTED_WAITING', { provider_commit_id: OTHER_COMMIT }), COMMIT, 0n, SAFETY),
      {
        kind: 'unexpected_state',
        detail: expected('COMMITTED_WAITING', OTHER_COMMIT),
      },
    );
    assert.deepEqual(decideBarrierStep({ state: 'SAFETY_RELEASED', version: 2 }, COMMIT, 0n, SAFETY), {
      kind: 'unexpected_state',
      detail: expected('SAFETY_RELEASED', 'none'),
    });
  });
});

describe('isCommittedWaitState', () => {
  it('is true exactly for the three committed waits', () => {
    assert.equal(isCommittedWaitState('COMMITTED_WAITING'), true);
    assert.equal(isCommittedWaitState('TIMEOUT_SIGNALLED'), true);
    assert.equal(isCommittedWaitState('TIMEOUT_OBSERVED'), true);
    assert.equal(isCommittedWaitState('ARMED'), false);
    assert.equal(isCommittedWaitState('RESPONSE_RELEASED'), false);
    assert.equal(isCommittedWaitState('SAFETY_RELEASED'), false);
    assert.equal(isCommittedWaitState(undefined), false);
  });
});
