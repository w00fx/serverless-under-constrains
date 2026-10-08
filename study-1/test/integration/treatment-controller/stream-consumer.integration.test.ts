// The controller behind the caller-journal stream (design §9.5): the StreamFeed emulator applies
// the mapping's filter, delivers one record per batch, re-delivers on purpose, and retries a
// failed invocation MaximumRetryAttempts (2) times before the on-failure destination.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import { consumeStreamEvent } from '../../../src/treatment-controller/stream-consumer.ts';
import { CONTROLLER_STREAM_FILTER } from '../../../src/treatment-controller/stream-record.ts';
import { StreamFeed } from '../../support/durable-store/stream-feed.ts';
import { ControllerLogRecorder } from '../../support/transport-rehearsal/controller-log-recorder.ts';
import {
  PROBE,
  PROBE_PK,
  callerTimeoutImage,
  committedTreatmentItem,
  controllerEvents,
  controllerHarness,
  probeConfigItem,
} from '../../unit/treatment-controller/support/controller-fixtures.ts';
import type { ControllerHarness } from '../../unit/treatment-controller/support/controller-fixtures.ts';

interface FedController {
  readonly harness: ControllerHarness;
  readonly feed: StreamFeed;
  readonly logs: ControllerLogRecorder;
}

function fedController(): FedController {
  const harness = controllerHarness(PROBE);
  harness.store.seed('control', probeConfigItem());
  harness.store.seed('control', committedTreatmentItem(PROBE_PK));
  const logs = new ControllerLogRecorder();
  const feed = new StreamFeed({
    source: harness.store,
    table: 'caller_journal',
    scheduler: harness.time,
    clock: harness.time,
    consumer: (event): Promise<void> => consumeStreamEvent(event, harness.controller, logs.sink),
    filters: [CONTROLLER_STREAM_FILTER],
  });
  feed.enable();
  return { harness, feed, logs };
}

async function put(harness: ControllerHarness, item: StoredItem): Promise<void> {
  const outcome = await harness.store.write({
    kind: 'put',
    table: 'caller_journal',
    item,
    condition: { kind: 'item_absent' },
  });
  assert.equal(outcome.kind, 'applied');
}

describe('controller stream mapping', () => {
  it('passes only INSERTs of caller_timeout_recorded and signals once', async () => {
    const { harness, feed, logs } = fedController();
    await put(harness, { pk: PROBE_PK, sk: 'state#attempt#x', phase: 'DISPATCHED' });
    await put(harness, {
      ...callerTimeoutImage('probe', { record_type: 'dispatch_started' }),
      sk: 'probe_caller#i#000000000003',
    });
    await put(harness, callerTimeoutImage('probe'));
    await harness.time.advanceUntilIdle();
    assert.equal(feed.skippedCount(), 2);
    assert.deepEqual(logs.handledOutcomes(), ['signal']);
    assert.deepEqual(
      feed.deliveries().map((delivery) => [delivery.event_name, delivery.outcome]),
      [['INSERT', 'succeeded']],
    );
  });

  it('skips a MODIFY of a caller timeout item', async () => {
    const { harness, feed, logs } = fedController();
    harness.store.seed('caller_journal', callerTimeoutImage('probe'));
    const outcome = await harness.store.write({
      kind: 'update',
      table: 'caller_journal',
      key: { pk: PROBE_PK, sk: callerTimeoutImage('probe').sk },
      set: { recorded_at: '2026-10-05T12:00:04.000Z' },
      condition: { kind: 'attribute_equals', name: 'record_type', value: 'caller_timeout_recorded' },
    });
    assert.equal(outcome.kind, 'applied');
    await harness.time.advanceUntilIdle();
    assert.equal(feed.skippedCount(), 1);
    assert.deepEqual(logs.lines(), []);
  });

  it('an at-least-once re-delivery is a duplicate, never a conflict', async () => {
    const { harness, feed, logs } = fedController();
    feed.duplicateNext();
    await put(harness, callerTimeoutImage('probe'));
    await harness.time.advanceUntilIdle();
    assert.deepEqual(logs.handledOutcomes(), ['signal', 'duplicate_ignored']);
    assert.deepEqual(
      controllerEvents(harness, PROBE_PK).map((event) => event.record_type),
      ['timeout_signal_recorded', 'timeout_signal_duplicate_observed'],
    );
  });

  it('a failing invocation is retried twice, then reaches the on-failure destination and the shard advances', async () => {
    const { harness, feed, logs } = fedController();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      harness.store.scriptReadFault('InternalServerError', { table: 'control' });
    }
    await put(harness, callerTimeoutImage('probe'));
    await put(
      harness,
      callerTimeoutImage('probe', {
        sk: 'probe_caller#j#000000000001',
        event_id: 'cafe0000-0000-4000-8000-0000000000e1',
      }),
    );
    await harness.time.advanceUntilIdle();
    assert.deepEqual(
      feed.deliveries().map((delivery) => delivery.outcome),
      ['failed', 'failed', 'failed', 'succeeded'],
    );
    assert.deepEqual(
      feed.onFailureRecords().map((record) => record.attempts),
      [3],
    );
    assert.deepEqual(
      logs.lines().map((line) => line.event),
      ['controller_fault', 'controller_fault', 'controller_fault', 'controller_record_handled'],
    );
    assert.deepEqual(logs.handledOutcomes(), ['signal']);
  });
});
