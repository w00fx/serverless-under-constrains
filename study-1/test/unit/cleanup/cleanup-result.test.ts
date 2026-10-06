// The frozen cleanup_result built from the fold (design §6.2 row 75): identity, status from step
// 9 and the resources, and deleted DLQ messages including those already gone.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CleanupActionEntry } from '../../../src/cleanup/cleanup-action-fold.ts';
import { foldCleanupActions } from '../../../src/cleanup/cleanup-action-fold.ts';
import { buildCleanupResult } from '../../../src/cleanup/cleanup-result.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { EXECUTION_ID, MANIFEST_SHA } from '../../support/cleanup/cleanup-fixtures.ts';

const AT = '2026-10-05T12:00:00.000Z' as UtcMillis;
const LATER = '2026-10-05T12:10:00.000Z' as UtcMillis;

function item(step: number, action: string, id: string): CleanupActionEntry {
  return {
    body: {
      step,
      step_status: 'started',
      cleanup_mode: 'EMERGENCY',
      cleanup_induced: false,
      action,
      resource_type: 'T',
      resource_identifier: id,
      reasons: [],
    },
    occurred_at: AT,
  };
}

describe('buildCleanupResult', () => {
  it('reports deleted and already-absent captured messages together, and the step-9 status', () => {
    const fold = foldCleanupActions([
      item(8, 'DLQ_MESSAGE_DELETED', 'm2'),
      item(8, 'DLQ_MESSAGE_ALREADY_ABSENT', 'm1'),
      item(8, 'DLQ_MESSAGE_DELETED', 'm1'),
      {
        body: {
          step: 9,
          step_status: 'succeeded',
          cleanup_mode: 'EMERGENCY',
          cleanup_induced: false,
          action: 'OWNED_RESOURCES_DELETE',
          reasons: [],
        },
        occurred_at: AT,
      },
    ]);
    const result = buildCleanupResult({
      execution: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: EXECUTION_ID },
      execution_manifest_sha256: MANIFEST_SHA,
      cleanup_mode: 'EMERGENCY',
      fold,
      started_at: AT,
      completed_at: LATER,
      duration_breach: true,
    });
    assert.deepEqual(result, {
      schema_version: 1,
      record_type: 'cleanup_result',
      transport_probe_id: EXECUTION_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      cleanup_mode: 'EMERGENCY',
      cleanup_status: 'succeeded',
      steps: fold.steps,
      resources: [],
      stopped_durable_execution_arns: [],
      deleted_dlq_message_ids: ['m1', 'm2'],
      duration_breach: true,
      started_at: AT,
      completed_at: LATER,
    });
  });

  it('is failed when step 9 never ran', () => {
    const result = buildCleanupResult({
      execution: { execution_kind: 'RUN', run_id: EXECUTION_ID },
      execution_manifest_sha256: MANIFEST_SHA,
      cleanup_mode: 'NORMAL',
      fold: foldCleanupActions([]),
      started_at: AT,
      completed_at: AT,
      duration_breach: false,
    });
    assert.equal(result.cleanup_status, 'failed');
    assert.deepEqual(result.steps, []);
  });
});
