// Conformance of the scripted lease against the behavior of `SessionExecutionLease` it stands in
// for: acquisition answers held or refused with a reason, a loss stops publication and reaches the
// heartbeat listener once while it runs, and finalization releases only a clean closure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LeaseLoss } from '../../../../src/coordination-lease/lease-session.ts';
import { ScriptedExecutionLease } from './scripted-execution-lease.ts';

const REFUSAL = { code: 'LEASE_HELD', subject: 'BR-RUA-045', detail: 'a foreign owner holds the lease' };

describe('ScriptedExecutionLease', () => {
  it('acquires, and releases after a clean closure or marks recovery after an unclean one', async () => {
    const lease = new ScriptedExecutionLease();
    assert.deepEqual(await lease.acquire(), { acquired: true });
    assert.equal(await lease.finalize('clean'), 'released');
    assert.equal(await lease.finalize('unclean'), 'recovery_required');
    assert.deepEqual(lease.calls(), ['acquire', 'finalize:clean', 'finalize:unclean']);
  });

  it('refuses with the scripted reason, and answers the scripted final status', async () => {
    const lease = new ScriptedExecutionLease({ refusal: REFUSAL, finalStatus: 'unverified' });
    assert.deepEqual(await lease.acquire(), { acquired: false, reason: REFUSAL });
    assert.equal(await lease.finalize('clean'), 'unverified');
  });

  it('tells the running heartbeat listener about a loss, and stops publication', () => {
    const lease = new ScriptedExecutionLease();
    const losses: LeaseLoss[] = [];
    lease.startHeartbeats((loss) => losses.push(loss));
    assert.equal(lease.publicationAllowed(), true);
    lease.lose();
    assert.equal(lease.publicationAllowed(), false);
    assert.equal(losses.length, 1);
    assert.equal(losses[0]?.cause, 'LEASE_LOST');
  });

  it('tells no listener once heartbeats stopped, or before they started', () => {
    const lease = new ScriptedExecutionLease();
    lease.lose();
    const losses: LeaseLoss[] = [];
    lease.startHeartbeats((loss) => losses.push(loss));
    lease.stopHeartbeats();
    lease.lose();
    assert.deepEqual(losses, []);
    assert.deepEqual(lease.calls(), ['startHeartbeats', 'stopHeartbeats']);
  });
});
