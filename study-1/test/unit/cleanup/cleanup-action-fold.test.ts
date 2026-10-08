// The fold of every cleanup run's actions into what the cleanup result reports (AC-RUA-011):
// latest step status with its start, latest step-9 action per resource, and the identifiers of
// item actions.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CleanupActionBody, CleanupActionEntry } from '../../../src/cleanup/cleanup-action-fold.ts';
import { foldCleanupActions, isResourceAction, stepStatusOf } from '../../../src/cleanup/cleanup-action-fold.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { QUEUE_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';

let clock = 0;

function entry(body: Partial<CleanupActionBody> & Pick<CleanupActionBody, 'step' | 'action'>): CleanupActionEntry {
  clock += 1;
  return {
    body: { step_status: 'started', cleanup_mode: 'NORMAL', cleanup_induced: false, reasons: [], ...body },
    occurred_at: `2026-10-05T12:00:${String(clock % 60).padStart(2, '0')}.000Z` as UtcMillis,
  };
}

const REASON = { code: 'X', subject: 's', detail: 'd' };

describe('foldCleanupActions: steps', () => {
  it('reports the latest step-level status with the start before it', () => {
    clock = 0;
    const entries = [
      entry({ step: 9, action: 'OWNED_RESOURCES_DELETE' }),
      entry({ step: 9, action: 'OWNED_RESOURCES_DELETE', step_status: 'failed', reasons: [REASON] }),
      entry({ step: 9, action: 'OWNED_RESOURCES_DELETE' }),
      entry({
        step: 9,
        action: 'DELETED',
        resource_type: 'T',
        resource_identifier: 'r',
        ownership_basis: 'recorded_stack',
      }),
      entry({ step: 9, action: 'OWNED_RESOURCES_DELETE', step_status: 'succeeded' }),
    ];
    const fold = foldCleanupActions(entries);
    assert.deepEqual(fold.steps, [
      {
        step: 9,
        status: 'succeeded',
        started_at: entries[2]?.occurred_at,
        completed_at: entries[4]?.occurred_at,
        reasons: [],
      },
    ]);
    assert.deepEqual([...fold.succeeded_steps], [9]);
    assert.equal(stepStatusOf(fold, 9), 'succeeded');
    assert.equal(stepStatusOf(fold, 1), undefined);
  });

  it('reports a started step with its start time only, and a terminal step without a start', () => {
    clock = 0;
    const entries = [
      entry({ step: 12, action: 'RESULTS_FREEZE' }),
      entry({ step: 4, action: 'PRE_CLEANUP_SNAPSHOT', step_status: 'skipped', reasons: [REASON] }),
    ];
    const fold = foldCleanupActions(entries);
    assert.deepEqual(fold.steps, [
      { step: 4, status: 'skipped', completed_at: entries[1]?.occurred_at, reasons: [REASON] },
      { step: 12, status: 'started', started_at: entries[0]?.occurred_at, reasons: [] },
    ]);
    assert.equal(fold.succeeded_steps.size, 0);
  });

  it('ignores item actions and step-level actions of another step when folding a step', () => {
    clock = 0;
    const fold = foldCleanupActions([
      entry({
        step: 3,
        action: 'CONSUMER_DISABLED',
        step_status: 'succeeded',
        resource_type: 'T',
        resource_identifier: 'm',
      }),
      entry({ step: 3, action: 'LATE_EVIDENCE_CUTOFF', step_status: 'succeeded' }),
    ]);
    assert.deepEqual(fold.steps, []);
  });
});

describe('foldCleanupActions: resources and identifiers', () => {
  it('keeps the latest step-9 action per resource, by canonical name', () => {
    clock = 0;
    const url = 'https://sqs.us-east-1.amazonaws.com/1/q.fifo';
    const fold = foldCleanupActions([
      entry({
        step: 9,
        action: 'DELETE_FAILED',
        resource_type: QUEUE_RESOURCE_TYPE,
        resource_identifier: url,
        ownership_basis: 'resource_manifest_and_tags',
        reasons: [REASON],
      }),
      entry({
        step: 9,
        action: 'EXCLUDED_BASELINE',
        resource_type: 'B',
        resource_identifier: 'b',
        ownership_basis: 'excluded_baseline',
      }),
      entry({
        step: 9,
        action: 'ALREADY_ABSENT',
        resource_type: QUEUE_RESOURCE_TYPE,
        resource_identifier: 'q.fifo',
        ownership_basis: 'resource_manifest_and_tags',
      }),
    ]);
    assert.deepEqual(fold.resources, [
      {
        resource_type: QUEUE_RESOURCE_TYPE,
        resource_identifier: 'q.fifo',
        ownership_basis: 'resource_manifest_and_tags',
        action: 'ALREADY_ABSENT',
        reasons: [],
      },
      {
        resource_type: 'B',
        resource_identifier: 'b',
        ownership_basis: 'excluded_baseline',
        action: 'EXCLUDED_BASELINE',
        reasons: [],
      },
    ]);
  });

  it('ignores resource actions outside step 9 or without a name or basis', () => {
    clock = 0;
    const fold = foldCleanupActions([
      entry({
        step: 8,
        action: 'DELETED',
        resource_type: 'T',
        resource_identifier: 'a',
        ownership_basis: 'recorded_stack',
      }),
      entry({ step: 9, action: 'DELETED', resource_identifier: 'b', ownership_basis: 'recorded_stack' }),
      entry({ step: 9, action: 'DELETED', resource_type: 'T', ownership_basis: 'recorded_stack' }),
      entry({ step: 9, action: 'DELETED', resource_type: 'T', resource_identifier: 'c' }),
      entry({
        step: 9,
        action: 'DURABLE_STOP_APPLIED',
        resource_type: 'T',
        resource_identifier: 'd',
        ownership_basis: 'recorded_stack',
      }),
    ]);
    assert.deepEqual(fold.resources, []);
  });

  it('collects item identifiers per action, unique and sorted', () => {
    clock = 0;
    const item = (action: string, id: string): CleanupActionEntry =>
      entry({ step: 5, action, resource_type: 'T', resource_identifier: id });
    const fold = foldCleanupActions([
      item('SAFETY_RELEASE_APPLIED', 'p2'),
      item('SAFETY_RELEASE_APPLIED', 'p1'),
      item('SAFETY_RELEASE_APPLIED', 'p2'),
      item('DURABLE_STOP_APPLIED', 'e1'),
      item('TREATMENT_SAFETY_RELEASED', 'p1'),
      item('DURABLE_EXECUTION_STOPPED', 'e1'),
      item('DLQ_MESSAGE_CAPTURED', 'm2'),
      item('DLQ_MESSAGE_CAPTURED', 'm1'),
      item('DLQ_MESSAGE_DELETED', 'm1'),
      item('DLQ_MESSAGE_ALREADY_ABSENT', 'm2'),
      entry({ step: 7, action: 'DLQ_MESSAGE_CAPTURED' }),
    ]);
    assert.deepEqual(fold.applied_releases, ['p1', 'p2']);
    assert.deepEqual(fold.stopped_durable_execution_arns, ['e1']);
    assert.deepEqual([...fold.recorded_safety_releases], ['p1']);
    assert.deepEqual([...fold.recorded_execution_stops], ['e1']);
    assert.deepEqual(fold.captured_dlq_message_ids, ['m1', 'm2']);
    assert.deepEqual(fold.deleted_dlq_message_ids, ['m1']);
    assert.deepEqual(fold.absent_dlq_message_ids, ['m2']);
  });
});

describe('isResourceAction', () => {
  it('accepts exactly the five step-9 resource actions', () => {
    assert.deepEqual(
      [
        'DELETED',
        'ALREADY_ABSENT',
        'DELETE_FAILED',
        'SKIPPED_AMBIGUOUS',
        'EXCLUDED_BASELINE',
        'CONSUMER_DISABLED',
        'deleted',
      ].map(isResourceAction),
      [true, true, true, true, true, false, false],
    );
  });
});
