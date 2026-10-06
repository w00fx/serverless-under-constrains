// Conformance of the runner stand-in RecordingLeaseLossListener (design §12.2): before any loss
// nothing is interrupted and no emergency cleanup is requested; each loss is kept in order with
// its monotonic arrival; the interruption cause is the first loss's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LeaseLoss } from '../../../../src/coordination-lease/lease-session.ts';
import { RecordingLeaseLossListener } from '../../../support/coordination-lease/recording-lease-loss-listener.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

const STALE: LeaseLoss = {
  cause: 'LEASE_LOST',
  health: 'LOST_STALE',
  reason: { code: 'LEASE_STALE', subject: 'BR-RUA-045', detail: 'stale' },
};
const MISMATCH: LeaseLoss = {
  cause: 'LEASE_LOST',
  health: 'LOST_OWNERSHIP_MISMATCH',
  reason: { code: 'LEASE_OWNERSHIP_MISMATCH', subject: 'BR-RUA-045', detail: 'mismatch' },
};

describe('RecordingLeaseLossListener', () => {
  it('requests nothing before a loss', () => {
    const listener = new RecordingLeaseLossListener(new VirtualTimeScheduler({ wallEpochMs: 0 }));
    assert.deepEqual(listener.losses(), []);
    assert.equal(listener.interruptionCause(), undefined);
    assert.equal(listener.emergencyCleanupRequested(), false);
  });

  it('records each loss with its arrival and interrupts with the first cause', async () => {
    const time = new VirtualTimeScheduler({ wallEpochMs: 0, monotonicOriginNs: 5n });
    const listener = new RecordingLeaseLossListener(time);
    listener.leaseLost(STALE);
    await time.advanceBy(1);
    listener.leaseLost(MISMATCH);
    assert.deepEqual(listener.losses(), [
      { loss: STALE, at_ns: 5n },
      { loss: MISMATCH, at_ns: 1_000_005n },
    ]);
    assert.equal(listener.interruptionCause(), 'LEASE_LOST');
    assert.equal(listener.emergencyCleanupRequested(), true);
  });

  it('returns a copy of its losses', () => {
    const listener = new RecordingLeaseLossListener(new VirtualTimeScheduler({ wallEpochMs: 0 }));
    listener.leaseLost(STALE);
    (listener.losses() as RecordingLossArray).push({ loss: MISMATCH, at_ns: 0n });
    assert.equal(listener.losses().length, 1);
  });
});

type RecordingLossArray = { loss: LeaseLoss; at_ns: bigint }[];
