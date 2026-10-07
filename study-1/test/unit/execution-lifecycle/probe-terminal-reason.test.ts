// CTR-RUA-003 probe terminal reason with its probe-result digest: the earliest stopping event wins
// (journal time order, whatever the input order), then a probe without a frozen result, then
// cleanup, then the leak audit, then a failed summary phase. The digest travels whenever P5 froze
// the result, and never without one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { deriveProbeTerminalReason } from '../../../src/execution-lifecycle/probe-terminal-reason.ts';
import type { ProbeTerminalInput } from '../../../src/execution-lifecycle/probe-terminal-reason.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { interruptionEvent, leaseEvent, phaseEvent } from '../study-comparison/support/runner-events.ts';

const DIGEST = 'a'.repeat(64) as Sha256Hex;

const CLEAN: ProbeTerminalInput = {
  events: [
    leaseEvent('ACQUIRED', 1),
    phaseEvent('TRIALS', 'succeeded', 10),
    phaseEvent('PROBE_FREEZE', 'succeeded', 11),
  ],
  probe_result_sha256: DIGEST,
  cleanup_status: 'succeeded',
  leak_audit_status: 'clean',
};

describe('deriveProbeTerminalReason', () => {
  it('is COMPLETED with the digest for a clean probe', () => {
    assert.deepEqual(deriveProbeTerminalReason(CLEAN), {
      probe_terminal_reason: 'COMPLETED',
      probe_result_sha256: DIGEST,
    });
  });

  it('maps each failed lifecycle phase to its stopping reason, keeping a frozen digest', () => {
    const cases = [
      ['LEASE_ACQUISITION', 'LEASE_ACQUISITION_FAILED'],
      ['PROVISIONING', 'PROVISIONING_FAILED'],
      ['READINESS', 'PROBE_INCOMPLETE'],
      ['TRIALS', 'PROBE_INCOMPLETE'],
      ['PROBE_FREEZE', 'EVIDENCE_FINALIZATION_FAILED'],
    ] as const;
    for (const [phase, reason] of cases) {
      assert.deepEqual(
        deriveProbeTerminalReason({ ...CLEAN, events: [phaseEvent(phase, 'failed', 5)] }),
        { probe_terminal_reason: reason, probe_result_sha256: DIGEST },
        phase,
      );
      assert.deepEqual(
        deriveProbeTerminalReason({
          ...CLEAN,
          events: [phaseEvent(phase, 'failed', 5)],
          probe_result_sha256: undefined,
        }),
        { probe_terminal_reason: reason },
        `${phase} without a frozen result`,
      );
    }
  });

  it('ignores closure phases and phases that did not fail as stopping events', () => {
    const events = [
      phaseEvent('LATE_MONITORING', 'failed', 20),
      phaseEvent('CLEANUP', 'failed', 40),
      phaseEvent('LEASE_FINALIZATION', 'failed', 45),
      phaseEvent('PROVISIONING', 'skipped', 5),
      phaseEvent('TRIALS', 'started', 6),
    ];
    assert.equal(deriveProbeTerminalReason({ ...CLEAN, events }).probe_terminal_reason, 'COMPLETED');
  });

  it('reports an interruption by its cause', () => {
    for (const cause of ['LEASE_LOST', 'OPERATOR_ABORT', 'SAFETY_DEADLINE', 'INTERRUPTED'] as const) {
      assert.equal(
        deriveProbeTerminalReason({ ...CLEAN, events: [interruptionEvent(cause, 20)] }).probe_terminal_reason,
        cause,
      );
    }
  });

  it('maps lease acquisition failure and lease loss, and no other lease event', () => {
    const cases = [
      ['ACQUISITION_FAILED', 'LEASE_ACQUISITION_FAILED'],
      ['LOST_OWNERSHIP_MISMATCH', 'LEASE_LOST'],
      ['LOST_STALE', 'LEASE_LOST'],
      ['HEARTBEAT_FAILED', 'COMPLETED'],
      ['RELEASE_FAILED', 'COMPLETED'],
    ] as const;
    for (const [event, reason] of cases) {
      assert.equal(
        deriveProbeTerminalReason({ ...CLEAN, events: [leaseEvent(event, 7)] }).probe_terminal_reason,
        reason,
        event,
      );
    }
  });

  it('keeps the earliest stopping event primary, whatever the input order', () => {
    const events = [interruptionEvent('OPERATOR_ABORT', 30), phaseEvent('READINESS', 'failed', 12)];
    assert.equal(deriveProbeTerminalReason({ ...CLEAN, events }).probe_terminal_reason, 'PROBE_INCOMPLETE');
    const reversed = [phaseEvent('PROBE_FREEZE', 'failed', 31), interruptionEvent('OPERATOR_ABORT', 30)];
    assert.equal(deriveProbeTerminalReason({ ...CLEAN, events: reversed }).probe_terminal_reason, 'OPERATOR_ABORT');
  });

  it('keeps journal order between events of the same instant', () => {
    const events = [leaseEvent('LOST_STALE', 9), interruptionEvent('OPERATOR_ABORT', 9)];
    assert.equal(deriveProbeTerminalReason({ ...CLEAN, events }).probe_terminal_reason, 'LEASE_LOST');
  });

  it('is PROBE_INCOMPLETE without a digest when P5 froze no result, before judging closure', () => {
    assert.deepEqual(
      deriveProbeTerminalReason({ ...CLEAN, probe_result_sha256: undefined, cleanup_status: 'failed' }),
      { probe_terminal_reason: 'PROBE_INCOMPLETE' },
    );
  });

  it('judges cleanup before the audit, and an absent closure as not clean', () => {
    for (const cleanup of ['partial', 'failed', undefined] as const) {
      assert.deepEqual(
        deriveProbeTerminalReason({ ...CLEAN, cleanup_status: cleanup, leak_audit_status: 'leaks_detected' }),
        { probe_terminal_reason: 'CLEANUP_INCOMPLETE', probe_result_sha256: DIGEST },
        String(cleanup),
      );
    }
    for (const audit of ['leaks_detected', 'inconclusive', undefined] as const) {
      assert.deepEqual(
        deriveProbeTerminalReason({ ...CLEAN, leak_audit_status: audit }),
        { probe_terminal_reason: 'LEAK_AUDIT_NOT_CLEAN', probe_result_sha256: DIGEST },
        String(audit),
      );
    }
  });

  it('is EVIDENCE_FINALIZATION_FAILED for a failed summary phase only', () => {
    const failed = [...CLEAN.events, phaseEvent('SUMMARY', 'failed', 50)];
    assert.deepEqual(deriveProbeTerminalReason({ ...CLEAN, events: failed }), {
      probe_terminal_reason: 'EVIDENCE_FINALIZATION_FAILED',
      probe_result_sha256: DIGEST,
    });
    const succeeded = [...CLEAN.events, phaseEvent('SUMMARY', 'succeeded', 50), phaseEvent('CLEANUP', 'failed', 51)];
    assert.equal(deriveProbeTerminalReason({ ...CLEAN, events: succeeded }).probe_terminal_reason, 'COMPLETED');
  });
});
