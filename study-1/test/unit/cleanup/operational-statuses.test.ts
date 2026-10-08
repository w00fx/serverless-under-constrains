// BR-RUA-051 statuses (design §8.18): the cleanup status of the deletion phase and the leak-audit
// status of the audit passes, branch by branch.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveCleanupStatus,
  deriveLeakAuditStatus,
  REQUIRED_AUDIT_PASSES,
  STABLE_ABSENCE_MS,
} from '../../../src/cleanup/operational-statuses.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { AuditPass } from '../../../src/record-contract/records/group-c/leak_audit_result.ts';

const AT = '2026-10-05T12:00:00.000Z' as UtcMillis;

function pass(options: { readonly ok?: boolean; readonly observed?: readonly string[] } = {}): AuditPass {
  return {
    started_at: AT,
    completed_at: AT,
    surfaces: [
      { surface: 'tables', query_ok: true, observed: [] },
      { surface: 'functions', query_ok: options.ok ?? true, observed: [...(options.observed ?? [])] },
    ],
  };
}

describe('deriveCleanupStatus', () => {
  it('is partial whenever a deletion failed, whatever step 9 says', () => {
    for (const step9 of ['succeeded', 'failed', 'started', undefined] as const) {
      assert.equal(deriveCleanupStatus({ step9_status: step9, resources: [{ action: 'DELETE_FAILED' }] }), 'partial');
    }
  });

  it('is succeeded when step 9 succeeded, counting already-absent resources as deleted', () => {
    const resources = [
      { action: 'DELETED' as const },
      { action: 'ALREADY_ABSENT' as const },
      { action: 'SKIPPED_AMBIGUOUS' as const },
    ];
    assert.equal(deriveCleanupStatus({ step9_status: 'succeeded', resources }), 'succeeded');
  });

  it('is failed when step 9 never completed', () => {
    for (const step9 of ['failed', 'skipped', 'started', undefined] as const) {
      assert.equal(deriveCleanupStatus({ step9_status: step9, resources: [] }), 'failed');
    }
  });
});

describe('deriveLeakAuditStatus', () => {
  const stable = { leak_count: 0, ambiguous_count: 0, stable_absence_interval_ms: STABLE_ABSENCE_MS };

  it('is clean after two absent passes at least 120 s apart', () => {
    assert.equal(REQUIRED_AUDIT_PASSES, 2);
    assert.equal(deriveLeakAuditStatus({ ...stable, passes: [pass(), pass()] }), 'clean');
  });

  it('is inconclusive with fewer than two passes, a failed query or an ambiguous resource', () => {
    assert.equal(deriveLeakAuditStatus({ ...stable, passes: [pass()] }), 'inconclusive');
    assert.equal(deriveLeakAuditStatus({ ...stable, passes: [] }), 'inconclusive');
    assert.equal(deriveLeakAuditStatus({ ...stable, passes: [pass(), pass({ ok: false })] }), 'inconclusive');
    assert.equal(
      deriveLeakAuditStatus({ ...stable, ambiguous_count: 1, leak_count: 1, passes: [pass(), pass()] }),
      'inconclusive',
    );
  });

  it('is leaks_detected when a pass observed an owned resource or a leak was found', () => {
    assert.equal(deriveLeakAuditStatus({ ...stable, passes: [pass({ observed: ['x'] }), pass()] }), 'leaks_detected');
    assert.equal(deriveLeakAuditStatus({ ...stable, leak_count: 1, passes: [pass(), pass()] }), 'leaks_detected');
  });

  it('is inconclusive when the passes were less than 120 s apart', () => {
    const early = { ...stable, stable_absence_interval_ms: STABLE_ABSENCE_MS - 1 };
    assert.equal(deriveLeakAuditStatus({ ...early, passes: [pass(), pass()] }), 'inconclusive');
  });
});
