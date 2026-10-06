// P3 readiness (design §10.2; D-10) against the emulated control table and event-source mappings:
// every mapping must report Enabled and the controller must acknowledge the runner's canary, each
// within a bounded wait; a canary that cannot be written, a deaf controller, an unreadable mapping
// and a failed acknowledgement read each give a reason instead of a hang. The full path with the
// real treatment controller answering the canary is covered by the runner tests.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { executionPartitionKey } from '../../../src/evidence-collection/capture-scope.ts';
import {
  CANARY_REFUND_REQUEST_ID,
  READINESS_POLL_MS,
  READINESS_TIMEOUT_MS,
  confirmReadiness,
} from '../../../src/execution-lifecycle/readiness.ts';
import type { ReadinessPorts } from '../../../src/execution-lifecycle/readiness.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { FakeConsumerControl } from '../../support/cleanup/fake-consumer-control.ts';
import { SelfAdvancingSleeper } from '../../support/cleanup/self-advancing-sleeper.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { RecordingMutationLog } from '../../support/kernel/recording-mutation-log.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { admittedOf, lifecycleServices } from './support/execution-fixtures.ts';

const CAUSATION = 'cafecafe-0000-4000-8000-000000000001' as Uuid4;
const admitted = admittedOf(offlineExecution('run'));
const canaryPartition = executionPartitionKey(admitted.identity, admitted.manifest_sha256, 'canary');

interface ReadinessWorld {
  readonly ports: ReadinessPorts;
  readonly consumers: FakeConsumerControl;
  readonly store: InMemoryItemStore;
  readonly sleeper: SelfAdvancingSleeper;
}

function readinessWorld(): ReadinessWorld {
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12, 5, 0, 0) });
  const sleeper = new SelfAdvancingSleeper(time);
  const consumers = new FakeConsumerControl(new RecordingMutationLog());
  const store = new InMemoryItemStore({ clock: time });
  return {
    ports: { consumers, store, services: lifecycleServices(time, sleeper).services },
    consumers,
    store,
    sleeper,
  };
}

function acknowledge(store: InMemoryItemStore, sortKey = 'z'): void {
  store.seed('experiment_journal', { pk: canaryPartition, sk: sortKey, record_type: 'controller_canary_acknowledged' });
}

describe('confirmReadiness', () => {
  it('is ready at once when every mapping is enabled and the canary is already acknowledged', async () => {
    const world = readinessWorld();
    world.consumers.add('m-1');
    acknowledge(world.store);
    assert.deepEqual(await confirmReadiness(world.ports, admitted, ['m-1'], CAUSATION), []);
    assert.deepEqual(world.sleeper.requests(), []);
    const canary = await world.store.queryPartitionPage('caller_journal', canaryPartition, undefined);
    assert.ok(canary.ok);
    const [event] = canary.value.items;
    assert.equal(event?.['record_type'], 'caller_timeout_recorded');
    assert.equal(event['refund_request_id'], CANARY_REFUND_REQUEST_ID);
    assert.equal(event['source'], 'runner');
    assert.deepEqual(event['causation_event_ids'], [CAUSATION]);
  });

  it('finds the acknowledgement on a later page of the partition', async () => {
    const world = readinessWorld();
    world.store.setPageSize(1);
    world.store.seed('experiment_journal', { pk: canaryPartition, sk: 'a', record_type: 'controller_started' });
    world.store.seed('experiment_journal', { pk: canaryPartition, sk: 'b', record_type: 'controller_started' });
    acknowledge(world.store, 'c');
    assert.deepEqual(await confirmReadiness(world.ports, admitted, [], CAUSATION), []);
  });

  it('gives up on a controller that never answers after the bounded wait', async () => {
    const world = readinessWorld();
    const reasons = await confirmReadiness(world.ports, admitted, [], CAUSATION);
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['CANARY_NOT_ACKNOWLEDGED'],
    );
    assert.match(reasons[0]?.detail ?? '', new RegExp(`after ${String(READINESS_TIMEOUT_MS)} ms`));
    assert.equal(world.sleeper.requests().length, READINESS_TIMEOUT_MS / READINESS_POLL_MS + 1);
  });

  it('counts a failed acknowledgement read as not acknowledged yet, and reads again', async () => {
    const world = readinessWorld();
    world.store.scriptReadFault('ProvisionedThroughputExceededException', {
      operation: 'queryPartitionPage',
      table: 'experiment_journal',
    });
    acknowledge(world.store);
    assert.deepEqual(await confirmReadiness(world.ports, admitted, [], CAUSATION), []);
    assert.deepEqual(world.sleeper.requests(), [READINESS_POLL_MS]);
  });

  it('reports a canary it could not write, without waiting for an answer', async () => {
    const world = readinessWorld();
    world.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'ValidationException' },
      { table: 'caller_journal' },
    );
    const reasons = await confirmReadiness(world.ports, admitted, [], CAUSATION);
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['CANARY_NOT_WRITTEN'],
    );
    assert.deepEqual(world.sleeper.requests(), []);
  });

  it('names every mapping that is absent, unreadable or not enabled after the bounded wait', async () => {
    const world = readinessWorld();
    world.consumers.add('enabled');
    world.consumers.add('disabled');
    await world.consumers.requestDisable('disabled');
    world.consumers.add('unreadable');
    world.consumers.failRead('unreadable');
    const reasons = await confirmReadiness(
      world.ports,
      admitted,
      ['enabled', 'disabled', 'unreadable', 'absent'],
      CAUSATION,
    );
    assert.deepEqual(
      reasons.map((reason) => reason.detail.split(' after ')[0]),
      [
        'event-source mapping disabled is State=Disabled',
        'event-source mapping unreadable is scripted state read failure; expected success',
        'event-source mapping absent is absent',
      ],
    );
    assert.ok(
      reasons.every((reason) => reason.code === 'EVENT_SOURCE_MAPPING_NOT_ENABLED' && reason.subject === 'D-10'),
    );
    const canary = await world.store.queryPartitionPage('caller_journal', canaryPartition, undefined);
    assert.deepEqual(canary.ok && canary.value.items, [], 'no canary before the mappings are enabled');
  });
});
