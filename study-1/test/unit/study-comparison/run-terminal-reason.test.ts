// CTR-RUA-002 run terminal reason and BR-RUA-045 final lease status: the earliest stopping event wins,
// then a trial left unfrozen, then cleanup, then the leak audit, then a failed summary phase; the
// last release, recovery or unverified-state lease event settles the lease status.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveRunTerminalReason, finalLeaseStatus } from '../../../src/study-comparison/run-terminal-reason.ts';
import type { RunTerminalInput } from '../../../src/study-comparison/run-terminal-reason.ts';
import { assertSchemaValid } from '../../golden/study-comparison/support/golden-views.ts';
import { interruptionEvent, leaseEvent, phaseEvent } from './support/runner-events.ts';

const CLEAN: RunTerminalInput = {
  events: [phaseEvent('TRIALS', 'succeeded', 10), leaseEvent('ACQUIRED', 1), leaseEvent('RELEASED', 50)],
  all_trials_frozen: true,
  cleanup_status: 'succeeded',
  leak_audit_status: 'clean',
};

describe('deriveRunTerminalReason', () => {
  it('builds schema-valid events', () => {
    for (const event of [
      phaseEvent('SUMMARY', 'failed', 3),
      interruptionEvent('INTERRUPTED', 4),
      leaseEvent('LOST_STALE', 5),
    ]) {
      assertSchemaValid(event.record_type, event);
    }
  });

  it('is COMPLETED for a clean run', () => {
    assert.equal(deriveRunTerminalReason(CLEAN), 'COMPLETED');
  });

  it('maps each failed lifecycle phase to its stopping reason', () => {
    const cases = [
      ['LEASE_ACQUISITION', 'LEASE_ACQUISITION_FAILED'],
      ['PROVISIONING', 'PROVISIONING_FAILED'],
      ['READINESS', 'TRIAL_INCOMPLETE'],
      ['TRIALS', 'TRIAL_INCOMPLETE'],
    ] as const;
    for (const [phase, reason] of cases) {
      assert.equal(deriveRunTerminalReason({ ...CLEAN, events: [phaseEvent(phase, 'failed', 5)] }), reason, phase);
    }
  });

  it('ignores failed closure phases and non-failed phases as stopping events', () => {
    const events = [phaseEvent('CLEANUP', 'failed', 40), phaseEvent('PROVISIONING', 'skipped', 5)];
    assert.equal(deriveRunTerminalReason({ ...CLEAN, events }), 'COMPLETED');
  });

  it('reports an interruption by its cause', () => {
    for (const cause of ['LEASE_LOST', 'OPERATOR_ABORT', 'SAFETY_DEADLINE', 'INTERRUPTED'] as const) {
      assert.equal(deriveRunTerminalReason({ ...CLEAN, events: [interruptionEvent(cause, 20)] }), cause);
    }
  });

  it('maps lease acquisition failure and lease loss', () => {
    const cases = [
      ['ACQUISITION_FAILED', 'LEASE_ACQUISITION_FAILED'],
      ['LOST_OWNERSHIP_MISMATCH', 'LEASE_LOST'],
      ['LOST_STALE', 'LEASE_LOST'],
    ] as const;
    for (const [event, reason] of cases) {
      assert.equal(deriveRunTerminalReason({ ...CLEAN, events: [leaseEvent(event, 7)] }), reason, event);
    }
  });

  it('keeps the earliest stopping event primary, whatever the journal order', () => {
    const events = [
      interruptionEvent('OPERATOR_ABORT', 30),
      leaseEvent('LOST_STALE', 20),
      phaseEvent('PROVISIONING', 'failed', 5),
    ];
    assert.equal(deriveRunTerminalReason({ ...CLEAN, events }), 'PROVISIONING_FAILED');
  });

  it('keeps journal order between events of the same instant', () => {
    const events = [interruptionEvent('OPERATOR_ABORT', 30), leaseEvent('LOST_STALE', 30)];
    assert.equal(deriveRunTerminalReason({ ...CLEAN, events }), 'OPERATOR_ABORT');
    assert.equal(deriveRunTerminalReason({ ...CLEAN, events: events.toReversed() }), 'LEASE_LOST');
  });

  it('a stopping event outranks every closure condition', () => {
    const input: RunTerminalInput = {
      events: [leaseEvent('LOST_STALE', 9)],
      all_trials_frozen: false,
      cleanup_status: 'failed',
      leak_audit_status: 'leaks_detected',
    };
    assert.equal(deriveRunTerminalReason(input), 'LEASE_LOST');
  });

  it('then judges unfrozen trials, cleanup and the leak audit, in that order', () => {
    const closure = { ...CLEAN, events: [] };
    assert.equal(
      deriveRunTerminalReason({ ...closure, all_trials_frozen: false, cleanup_status: 'failed' }),
      'TRIAL_INCOMPLETE',
    );
    assert.equal(
      deriveRunTerminalReason({ ...closure, cleanup_status: 'partial', leak_audit_status: 'leaks_detected' }),
      'CLEANUP_INCOMPLETE',
    );
    assert.equal(deriveRunTerminalReason({ ...closure, cleanup_status: undefined }), 'CLEANUP_INCOMPLETE');
    assert.equal(deriveRunTerminalReason({ ...closure, leak_audit_status: 'leaks_detected' }), 'LEAK_AUDIT_NOT_CLEAN');
    assert.equal(deriveRunTerminalReason({ ...closure, leak_audit_status: undefined }), 'LEAK_AUDIT_NOT_CLEAN');
  });

  it('is EVIDENCE_FINALIZATION_FAILED only after a failed summary phase', () => {
    assert.equal(
      deriveRunTerminalReason({ ...CLEAN, events: [phaseEvent('SUMMARY', 'failed', 55)] }),
      'EVIDENCE_FINALIZATION_FAILED',
    );
    assert.equal(deriveRunTerminalReason({ ...CLEAN, events: [phaseEvent('SUMMARY', 'succeeded', 55)] }), 'COMPLETED');
  });

  it('ends COMPLETED after a failed lease release (F12)', () => {
    const events = [leaseEvent('RELEASE_FAILED', 58)];
    // CTR-RUA-002 has no reason for a failed lease release; the lease status reports it instead.
    assert.equal(deriveRunTerminalReason({ ...CLEAN, events }), 'COMPLETED');
  });
});

describe('finalLeaseStatus', () => {
  it('is unverified with no settling event (TTL expiry never establishes release)', () => {
    assert.equal(finalLeaseStatus([]), 'unverified');
    assert.equal(finalLeaseStatus([leaseEvent('ACQUIRED', 1), leaseEvent('HEARTBEAT_CONFIRMED', 2)]), 'unverified');
  });

  it('maps each settling event', () => {
    const cases = [
      ['RELEASED', 'released'],
      ['RECOVERY_REQUIRED', 'recovery_required'],
      ['RELEASE_FAILED', 'unverified'],
      ['STATE_UNVERIFIED', 'unverified'],
    ] as const;
    for (const [event, status] of cases) {
      assert.equal(finalLeaseStatus([leaseEvent('ACQUIRED', 1), leaseEvent(event, 50)]), status, event);
    }
  });

  it('takes the latest settling event in time order', () => {
    assert.equal(finalLeaseStatus([leaseEvent('RELEASED', 52), leaseEvent('RECOVERY_REQUIRED', 50)]), 'released');
    assert.equal(
      finalLeaseStatus([leaseEvent('RECOVERY_REQUIRED', 52), leaseEvent('RELEASED', 50)]),
      'recovery_required',
    );
  });
});
