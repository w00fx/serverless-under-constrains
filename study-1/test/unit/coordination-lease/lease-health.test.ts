// The pure lease-health state machine (BR-RUA-045; design §10.3): the transitions of every
// observation, the 300 s stale boundary to the nanosecond (one nanosecond short keeps the
// lease, the boundary itself loses it), absorbing losses, the publication gate, the heartbeat
// delay that reaches the boundary, and the final lease status of an event history.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LeaseHealthState, LeaseObservation } from '../../../src/coordination-lease/lease-health.ts';
import {
  LEASE_HEARTBEAT_INTERVAL_MS,
  LEASE_STALE_BOUNDARY_NS,
  deriveFinalLeaseStatus,
  heartbeatDelayMs,
  isLost,
  isPublicationAllowed,
  nextLeaseHealth,
} from '../../../src/coordination-lease/lease-health.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { LeaseHealth } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { EPOCH_UTC } from '../../support/coordination-lease/lease-fixtures.ts';

const SECOND_NS = 1_000_000_000n;
const ORIGIN_NS = 7n * SECOND_NS;
const LATER = '2026-10-05T12:01:00.000Z' as UtcMillis;

function state(health: LeaseHealth, version = 3): LeaseHealthState {
  return { health, lease_version: version, last_confirmed_ns: ORIGIN_NS, last_confirmed_at: EPOCH_UTC };
}

const confirmedAt = (issued: bigint, observed: bigint, version = 4): LeaseObservation => ({
  kind: 'confirmed',
  issued_ns: issued,
  observed_ns: observed,
  at: LATER,
  lease_version: version,
});

describe('lease health constants', () => {
  it('pin the 30 s interval and the 300 s boundary', () => {
    assert.equal(LEASE_HEARTBEAT_INTERVAL_MS, 30_000);
    assert.equal(LEASE_STALE_BOUNDARY_NS, 300n * SECOND_NS);
  });
});

describe('nextLeaseHealth', () => {
  it('confirms from the write issue instant, at the confirmed version', () => {
    const next = nextLeaseHealth(
      state('CONFIRMED'),
      confirmedAt(ORIGIN_NS + 30n * SECOND_NS, ORIGIN_NS + 31n * SECOND_NS),
    );
    assert.deepEqual(next, {
      health: 'CONFIRMED',
      lease_version: 4,
      last_confirmed_ns: ORIGIN_NS + 30n * SECOND_NS,
      last_confirmed_at: LATER,
    });
  });

  it('enters uncertainty on a failure and keeps the last confirmation', () => {
    const next = nextLeaseHealth(state('CONFIRMED'), { kind: 'failed', observed_ns: ORIGIN_NS + 30n * SECOND_NS });
    assert.deepEqual(next, state('UNCERTAIN'));
  });

  it('adopts the version an unseen earlier write established', () => {
    const next = nextLeaseHealth(state('CONFIRMED'), { kind: 'failed', observed_ns: ORIGIN_NS, adopted_version: 5 });
    assert.deepEqual(next, state('UNCERTAIN', 5));
  });

  it('recovers from uncertainty on a confirmation before the boundary', () => {
    const observed = ORIGIN_NS + LEASE_STALE_BOUNDARY_NS - 1n;
    assert.equal(nextLeaseHealth(state('UNCERTAIN'), confirmedAt(observed - SECOND_NS, observed)).health, 'CONFIRMED');
  });

  it('loses on an ownership mismatch', () => {
    const next = nextLeaseHealth(state('UNCERTAIN'), { kind: 'mismatch', observed_ns: ORIGIN_NS, code: 'X' });
    assert.deepEqual(next, state('LOST_OWNERSHIP_MISMATCH'));
  });

  it('keeps the state when only time passed inside the boundary', () => {
    const before = state('UNCERTAIN');
    assert.equal(
      nextLeaseHealth(before, { kind: 'clock', observed_ns: ORIGIN_NS + LEASE_STALE_BOUNDARY_NS - 1n }),
      before,
    );
  });

  it('judges staleness first: at the boundary every observation, even a confirmation, loses', () => {
    const atBoundary = ORIGIN_NS + LEASE_STALE_BOUNDARY_NS;
    const observations: readonly LeaseObservation[] = [
      confirmedAt(atBoundary - SECOND_NS, atBoundary),
      { kind: 'failed', observed_ns: atBoundary, adopted_version: 9 },
      { kind: 'mismatch', observed_ns: atBoundary, code: 'X' },
      { kind: 'clock', observed_ns: atBoundary },
    ];
    for (const health of ['CONFIRMED', 'UNCERTAIN'] as const) {
      for (const observation of observations) {
        assert.deepEqual(nextLeaseHealth(state(health), observation), state('LOST_STALE'));
      }
    }
  });

  it('keeps losses absorbing', () => {
    for (const lost of ['LOST_STALE', 'LOST_OWNERSHIP_MISMATCH'] as const) {
      const before = state(lost);
      assert.equal(nextLeaseHealth(before, confirmedAt(ORIGIN_NS, ORIGIN_NS + 1n)), before);
      assert.equal(
        nextLeaseHealth(before, { kind: 'clock', observed_ns: ORIGIN_NS + LEASE_STALE_BOUNDARY_NS }),
        before,
      );
    }
  });
});

describe('isLost', () => {
  it('holds for the two losses only', () => {
    assert.deepEqual((['CONFIRMED', 'UNCERTAIN', 'LOST_OWNERSHIP_MISMATCH', 'LOST_STALE'] as const).map(isLost), [
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('isPublicationAllowed', () => {
  it('allows publication only while confirmed and younger than the boundary', () => {
    assert.equal(isPublicationAllowed(state('CONFIRMED'), ORIGIN_NS + LEASE_STALE_BOUNDARY_NS - 1n), true);
    assert.equal(isPublicationAllowed(state('CONFIRMED'), ORIGIN_NS + LEASE_STALE_BOUNDARY_NS), false);
  });

  it('blocks publication while uncertain or lost', () => {
    for (const health of ['UNCERTAIN', 'LOST_OWNERSHIP_MISMATCH', 'LOST_STALE'] as const) {
      assert.equal(isPublicationAllowed(state(health), ORIGIN_NS), false);
    }
  });
});

describe('heartbeatDelayMs', () => {
  it('is the 30 s interval while confirmed or lost', () => {
    for (const health of ['CONFIRMED', 'LOST_STALE'] as const) {
      assert.equal(heartbeatDelayMs(state(health), ORIGIN_NS + 290n * SECOND_NS), 30_000);
    }
  });

  it('is the interval while uncertain and the boundary is far', () => {
    assert.equal(heartbeatDelayMs(state('UNCERTAIN'), ORIGIN_NS + 30n * SECOND_NS), 30_000);
    assert.equal(heartbeatDelayMs(state('UNCERTAIN'), ORIGIN_NS + 270n * SECOND_NS), 30_000);
  });

  it('lands on the boundary while uncertain, rounding up to whole milliseconds', () => {
    assert.equal(heartbeatDelayMs(state('UNCERTAIN'), ORIGIN_NS + 280n * SECOND_NS), 20_000);
    assert.equal(heartbeatDelayMs(state('UNCERTAIN'), ORIGIN_NS + LEASE_STALE_BOUNDARY_NS - 1n), 1);
    assert.equal(heartbeatDelayMs(state('UNCERTAIN'), ORIGIN_NS + LEASE_STALE_BOUNDARY_NS - 1_000_001n), 2);
  });

  it('is zero at or past the boundary', () => {
    assert.equal(heartbeatDelayMs(state('UNCERTAIN'), ORIGIN_NS + LEASE_STALE_BOUNDARY_NS), 0);
    assert.equal(heartbeatDelayMs(state('UNCERTAIN'), ORIGIN_NS + LEASE_STALE_BOUNDARY_NS + 5n * SECOND_NS), 0);
  });
});

describe('deriveFinalLeaseStatus', () => {
  it('maps each settling event to its BR-RUA-045 status', () => {
    assert.equal(deriveFinalLeaseStatus(['ACQUIRED', 'HEARTBEAT_CONFIRMED', 'RELEASED']), 'released');
    assert.equal(deriveFinalLeaseStatus(['ACQUIRED', 'RECOVERY_REQUIRED']), 'recovery_required');
    assert.equal(deriveFinalLeaseStatus(['ACQUIRED', 'RELEASE_FAILED']), 'unverified');
    assert.equal(deriveFinalLeaseStatus(['ACQUIRED', 'LOST_STALE', 'STATE_UNVERIFIED']), 'unverified');
  });

  it('takes the last settling event', () => {
    assert.equal(deriveFinalLeaseStatus(['RELEASE_FAILED', 'RELEASED']), 'released');
    assert.equal(deriveFinalLeaseStatus(['RELEASED', 'HEARTBEAT_CONFIRMED']), 'released');
  });

  it('is unverified when release was never established (TTL expiry never establishes it)', () => {
    assert.equal(deriveFinalLeaseStatus([]), 'unverified');
    assert.equal(deriveFinalLeaseStatus(['ACQUIRED', 'HEARTBEAT_FAILED', 'LOST_STALE']), 'unverified');
  });
});
