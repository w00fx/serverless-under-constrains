// The canonical validation terminal reason (BR-RUA-038; design §10.2, §10.3): the earliest causal
// condition of the lifecycle, else `COMPLETED`. Execution-time causes come first in journal order,
// then cleanup and leak-audit closure, then lease finalization.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { OriginalClosure } from '../../../src/evidence-package/effective-operational-state.ts';
import type { ExecutionPhase, LeaseEvent } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { ValidationTerminalReason } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { deriveValidationTerminalReason } from '../../../src/variant-validation/validation-terminal-reason.ts';
import { interruptedEvent, leaseEvent, phaseEvent, safetyEvent } from './support/lifecycle-events.ts';

const CLEAN: OriginalClosure = { cleanup_status: 'succeeded', leak_audit_status: 'clean', lease_status: 'released' };

describe('deriveValidationTerminalReason', () => {
  it('is COMPLETED when nothing failed and the closure is clean', () => {
    const events = [
      phaseEvent('TRIALS', 'started'),
      phaseEvent('TRIALS', 'succeeded'),
      safetyEvent('ACTIVE_TIME', 'within_limits'),
    ];
    assert.equal(deriveValidationTerminalReason(events, CLEAN), 'COMPLETED');
  });

  const failedPhases: readonly (readonly [ExecutionPhase, ValidationTerminalReason | 'COMPLETED'])[] = [
    ['LEASE_ACQUISITION', 'LEASE_ACQUISITION_FAILED'],
    ['PROVISIONING', 'PROVISIONING_FAILED'],
    ['READINESS', 'VALIDATION_INCOMPLETE'],
    ['TRIALS', 'VALIDATION_INCOMPLETE'],
    ['PROBE_FREEZE', 'EVIDENCE_FINALIZATION_FAILED'],
    ['LATE_MONITORING', 'COMPLETED'],
    ['CLEANUP', 'CLEANUP_INCOMPLETE'],
    ['LEASE_FINALIZATION', 'LEASE_STATE_UNVERIFIED'],
    ['SUMMARY', 'EVIDENCE_FINALIZATION_FAILED'],
  ];
  for (const [phase, expected] of failedPhases) {
    it(`maps a failed ${phase} phase to ${expected}`, () => {
      assert.equal(deriveValidationTerminalReason([phaseEvent(phase, 'failed')], CLEAN), expected);
    });
  }

  it('gives a trial interruption its own cause', () => {
    for (const cause of ['LEASE_LOST', 'OPERATOR_ABORT', 'SAFETY_DEADLINE', 'INTERRUPTED'] as const) {
      assert.equal(deriveValidationTerminalReason([interruptedEvent(cause)], CLEAN), cause);
    }
  });

  it('maps a breached active-time check to SAFETY_DEADLINE and any other breach to SAFETY_LIMIT_EXCEEDED', () => {
    assert.equal(deriveValidationTerminalReason([safetyEvent('ACTIVE_TIME', 'breached')], CLEAN), 'SAFETY_DEADLINE');
    assert.equal(
      deriveValidationTerminalReason([safetyEvent('TOTAL_TIME', 'breached')], CLEAN),
      'SAFETY_LIMIT_EXCEEDED',
    );
    assert.equal(deriveValidationTerminalReason([safetyEvent('BILLED_COST', 'unverified')], CLEAN), 'COMPLETED');
  });

  const leaseEvents: readonly (readonly [LeaseEvent, ValidationTerminalReason | 'COMPLETED'])[] = [
    ['ACQUIRED', 'COMPLETED'],
    ['ACQUISITION_FAILED', 'LEASE_ACQUISITION_FAILED'],
    ['HEARTBEAT_CONFIRMED', 'COMPLETED'],
    ['HEARTBEAT_FAILED', 'COMPLETED'],
    ['RECOVERED', 'COMPLETED'],
    ['LOST_OWNERSHIP_MISMATCH', 'LEASE_LOST'],
    ['LOST_STALE', 'LEASE_LOST'],
    ['RELEASED', 'COMPLETED'],
    ['RELEASE_FAILED', 'LEASE_RELEASE_FAILED'],
    ['RECOVERY_REQUIRED', 'COMPLETED'],
    ['STATE_UNVERIFIED', 'LEASE_STATE_UNVERIFIED'],
  ];
  for (const [event, expected] of leaseEvents) {
    it(`maps the lease event ${event} to ${expected}`, () => {
      assert.equal(deriveValidationTerminalReason([leaseEvent(event)], CLEAN), expected);
    });
  }

  it('reports the earliest execution-time cause in journal order', () => {
    const events = [
      phaseEvent('PROVISIONING', 'failed'),
      interruptedEvent('OPERATOR_ABORT'),
      phaseEvent('CLEANUP', 'failed'),
    ];
    assert.equal(deriveValidationTerminalReason(events, { ...CLEAN, cleanup_status: 'failed' }), 'PROVISIONING_FAILED');
  });

  it('reports cleanup closure before a lease-finalization cause that was journaled earlier', () => {
    const events = [leaseEvent('RELEASE_FAILED')];
    assert.equal(deriveValidationTerminalReason(events, { ...CLEAN, cleanup_status: 'partial' }), 'CLEANUP_INCOMPLETE');
    assert.equal(
      deriveValidationTerminalReason(events, { ...CLEAN, leak_audit_status: 'leaks_detected' }),
      'LEAK_AUDIT_NOT_CLEAN',
    );
    assert.equal(deriveValidationTerminalReason(events, CLEAN), 'LEASE_RELEASE_FAILED');
  });

  it('falls back to the final lease status when no event names a cause', () => {
    assert.equal(
      deriveValidationTerminalReason([], { ...CLEAN, lease_status: 'recovery_required' }),
      'LEASE_RELEASE_FAILED',
    );
    assert.equal(
      deriveValidationTerminalReason([], { ...CLEAN, lease_status: 'unverified' }),
      'LEASE_STATE_UNVERIFIED',
    );
  });

  it('prefers a recorded finalization cause over the lease fallback', () => {
    const events = [leaseEvent('STATE_UNVERIFIED')];
    assert.equal(
      deriveValidationTerminalReason(events, { ...CLEAN, lease_status: 'recovery_required' }),
      'LEASE_STATE_UNVERIFIED',
    );
  });
});
