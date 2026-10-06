// The pre-cleanup snapshot (design §10.4 step 4; BR-RUA-048, RK-10): treatment states, provider
// activity, Durable executions and queue counters before cleanup mutates anything, best effort
// with every failed read recorded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { capturePreCleanupSnapshot } from '../../../src/evidence-collection/pre-cleanup-snapshot.ts';
import type { PreCleanupPlan } from '../../../src/evidence-collection/pre-cleanup-snapshot.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { DIGESTS } from '../../contract/record-contract/group-a/support/sample-values.ts';
import {
  assertValidRecord,
  collectionClock,
  DURABLE_FUNCTION_ARN,
  EXECUTION,
  journalItem,
  PROBE_PK,
  sdkExecution,
  TRIAL_PK,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDurableExecutionReader } from '../../support/evidence-collection/scripted-durable-execution-reader.ts';
import { ScriptedQueueCounterReader } from '../../support/evidence-collection/scripted-queue-counter-reader.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';

const SOURCE = { queue_url: 'https://sqs/src', queue_name: 'suc1-src.fifo' };
const DLQ = { queue_url: 'https://sqs/dlq', queue_name: 'suc1-dlq.fifo' };

function plan(mode: 'NORMAL' | 'EMERGENCY', partitions: readonly string[]): PreCleanupPlan {
  return {
    execution: EXECUTION,
    execution_manifest_sha256: DIGESTS.executionManifest,
    cleanup_mode: mode,
    partition_keys: partitions,
    durable_listings: [
      { function_arn: DURABLE_FUNCTION_ARN, qualifier: '3', started_after: '2026-10-05T12:00:00.000Z' as UtcMillis },
    ],
    queues: [SOURCE, DLQ],
  };
}

describe('capturePreCleanupSnapshot', () => {
  it('records each partition, each execution and each queue', async () => {
    const { store } = storeHarness();
    store.seed('control', { pk: TRIAL_PK, sk: 'treatment', state: 'COMMITTED_WAITING', version: 2 });
    store.seed(
      'experiment_journal',
      journalItem(TRIAL_PK, 'refund_provider', 1, { record_type: 'provider_call_received', provider_call_id: 'c1' }),
    );
    store.seed(
      'experiment_journal',
      journalItem(TRIAL_PK, 'treatment_controller', 1, {
        record_type: 'timeout_signal_recorded',
        provider_call_id: 'c9',
      }),
    );
    const queues = new ScriptedQueueCounterReader();
    queues.setCounters(SOURCE.queue_url, { visible: 0, in_flight: 0, delayed: 0 });
    queues.setCounters(DLQ.queue_url, { visible: 1, in_flight: 0, delayed: 0 });
    const durable = new ScriptedDurableExecutionReader();
    durable.addExecution(sdkExecution(1, 'RUNNING'), []);
    const snapshot = await capturePreCleanupSnapshot(
      { store, queues, durable, clock: collectionClock() },
      plan('NORMAL', [TRIAL_PK, PROBE_PK]),
    );
    assertValidRecord(snapshot.record, 'pre_cleanup_snapshot');
    assert.deepEqual(snapshot.failures, []);
    assert.deepEqual(snapshot.record['treatment_states'], [
      { partition_key: TRIAL_PK, read_status: 'ok', state: 'COMMITTED_WAITING', version: 2 },
      { partition_key: PROBE_PK, read_status: 'absent' },
    ]);
    assert.deepEqual(snapshot.record['provider_activity'], [
      { partition_key: TRIAL_PK, active_calls: 1, held_barriers: 1, pending_releases: 0 },
      { partition_key: PROBE_PK, active_calls: 0, held_barriers: 0, pending_releases: 0 },
    ]);
    assert.deepEqual(snapshot.record['durable_executions'], [
      { durable_execution_arn: sdkExecution(1, 'RUNNING').DurableExecutionArn, status: 'RUNNING' },
    ]);
    assert.deepEqual(snapshot.record['queues'], [
      { queue_name: 'suc1-src.fifo', read_status: 'ok', counters: { visible: 0, in_flight: 0, delayed: 0 } },
      { queue_name: 'suc1-dlq.fifo', read_status: 'ok', counters: { visible: 1, in_flight: 0, delayed: 0 } },
    ]);
    assert.equal(snapshot.record['cleanup_mode'], 'NORMAL');
    assert.equal('trial_id' in snapshot.record, false);
  });

  it('records every failed read and still writes the snapshot (emergency, best effort)', async () => {
    const { store } = storeHarness();
    store.seed('control', { pk: PROBE_PK, sk: 'treatment', state: 'BROKEN', version: 0 });
    store.seed('experiment_journal', journalItem(PROBE_PK, 'refund_provider', 1, { provider_call_id: 'c1' }));
    store.scriptReadFault('InternalServerError', { operation: 'getConsistent', table: 'control' });
    store.scriptReadFault('ProvisionedThroughputExceededException', { operation: 'queryPartitionPage' });
    const queues = new ScriptedQueueCounterReader();
    queues.setCounters(DLQ.queue_url, { visible: 0, in_flight: 0, delayed: 0 });
    const durable = new ScriptedDurableExecutionReader();
    durable.scriptFailure('listPage', 'ServiceException');
    const snapshot = await capturePreCleanupSnapshot(
      { store, queues, durable, clock: collectionClock() },
      plan('EMERGENCY', [TRIAL_PK, PROBE_PK, `${TRIAL_PK}x`]),
    );
    assertValidRecord(snapshot.record, 'emergency pre_cleanup_snapshot');
    assert.deepEqual(snapshot.record['treatment_states'], [
      { partition_key: TRIAL_PK, read_status: 'unavailable' },
      { partition_key: PROBE_PK, read_status: 'unavailable' },
      { partition_key: `${TRIAL_PK}x`, read_status: 'absent' },
    ]);
    assert.deepEqual(snapshot.record['provider_activity'], [
      { partition_key: `${TRIAL_PK}x`, active_calls: 0, held_barriers: 0, pending_releases: 0 },
    ]);
    assert.deepEqual(snapshot.record['queues'], [
      { queue_name: 'suc1-src.fifo', read_status: 'unavailable' },
      { queue_name: 'suc1-dlq.fifo', read_status: 'ok', counters: { visible: 0, in_flight: 0, delayed: 0 } },
    ]);
    assert.deepEqual(
      snapshot.failures.map((failure) => failure.code),
      [
        'STATE_READ_FAILED',
        'TREATMENT_ITEM_MALFORMED',
        'PARTITION_READ_FAILED',
        'DURABLE_PAGE_READ_FAILED',
        'QUEUE_READ_FAILED',
      ],
    );
    assert.deepEqual(
      snapshot.record['failures'],
      snapshot.failures.map((failure) => ({ ...failure })),
    );
  });
});
