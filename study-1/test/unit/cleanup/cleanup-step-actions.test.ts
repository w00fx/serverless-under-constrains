// The item-level work of steps 3, 5, 6, 7 and 8 (BR-RUA-048; design §10.4): consumer shutdown
// with polling, barrier release and durable stops, cleanup-induced transitions recorded once,
// DLQ capture, and deletion of captured messages only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldCleanupActions } from '../../../src/cleanup/cleanup-action-fold.ts';
import type { CleanupActionEntry } from '../../../src/cleanup/cleanup-action-fold.ts';
import { ControlTableBarrierRelease } from '../../../src/cleanup/control-barrier-release.ts';
import {
  CONSUMER_MAX_POLLS,
  CONSUMER_POLL_INTERVAL_MS,
  disableConsumers,
} from '../../../src/cleanup/consumer-shutdown.ts';
import { captureDlqEvidence, deleteCapturedDlqMessages } from '../../../src/cleanup/dlq-cleanup.ts';
import {
  recordInducedTransitions,
  releaseBarriersAndStopExecutions,
} from '../../../src/cleanup/execution-quiescing.ts';
import type { ItemAction } from '../../../src/cleanup/step-recording.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { EPOCH_MS, STACK_ID } from '../../support/cleanup/cleanup-fixtures.ts';
import { FakeConsumerControl } from '../../support/cleanup/fake-consumer-control.ts';
import { FakeDlqMessages } from '../../support/cleanup/fake-dlq-messages.ts';
import { FakeDurableExecutions } from '../../support/cleanup/fake-durable-executions.ts';
import { RecordingCleanupEvidence } from '../../support/cleanup/recording-cleanup-evidence.ts';
import { SelfAdvancingSleeper } from '../../support/cleanup/self-advancing-sleeper.ts';
import { StubDiscoverySurfaces } from '../../support/cleanup/stub-discovery-surfaces.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { RecordingMutationLog } from '../../support/kernel/recording-mutation-log.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

interface Recorder {
  readonly items: ItemAction[];
  readonly record: (item: ItemAction) => Promise<void>;
}

function recorder(): Recorder {
  const items: ItemAction[] = [];
  return {
    items,
    record: (item): Promise<void> => {
      items.push(item);
      return Promise.resolve();
    },
  };
}

function actions(items: readonly ItemAction[]): string[] {
  return items.map((item) => `${item.action} ${item.resource_identifier}`);
}

describe('disableConsumers (step 3)', () => {
  it('disables each mapping, waiting for Disabled, and counts an absent one as disabled', async () => {
    const consumers = new FakeConsumerControl(new RecordingMutationLog());
    consumers.add('m-slow', 3);
    const sleeper = new SelfAdvancingSleeper(new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }));
    const { items, record } = recorder();
    const outcome = await disableConsumers(['m-slow', 'm-gone'], consumers, sleeper, record);
    assert.deepEqual(outcome, { status: 'succeeded', reasons: [] });
    assert.deepEqual(actions(items), ['CONSUMER_DISABLED m-slow', 'CONSUMER_ALREADY_ABSENT m-gone']);
    assert.deepEqual(sleeper.requests(), [CONSUMER_POLL_INTERVAL_MS, CONSUMER_POLL_INTERVAL_MS]);
  });

  it('counts a mapping that disappears while disabling as absent', async () => {
    const consumers = new FakeConsumerControl(new RecordingMutationLog());
    consumers.add('m-1');
    consumers.deleteAfterRequest('m-1');
    const { items, record } = recorder();
    await disableConsumers(
      ['m-1'],
      consumers,
      new SelfAdvancingSleeper(new VirtualTimeScheduler({ wallEpochMs: 0 })),
      record,
    );
    assert.deepEqual(actions(items), ['CONSUMER_ALREADY_ABSENT m-1']);
  });

  it('fails a mapping whose request fails or that never reports Disabled, and goes on', async () => {
    const consumers = new FakeConsumerControl(new RecordingMutationLog());
    consumers.add('m-refused');
    consumers.failRequest('m-refused');
    consumers.add('m-stuck', CONSUMER_MAX_POLLS + 1);
    consumers.add('m-unreadable');
    consumers.failRead('m-unreadable');
    consumers.add('m-ok');
    const sleeper = new SelfAdvancingSleeper(new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }));
    const { items, record } = recorder();
    const outcome = await disableConsumers(
      ['m-refused', 'm-stuck', 'm-unreadable', 'm-ok'],
      consumers,
      sleeper,
      record,
    );
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(
      outcome.reasons.map((reason) => `${reason.code} ${reason.subject}`),
      ['ServiceException m-refused', 'CONSUMER_NOT_DISABLED m-stuck', 'CONSUMER_NOT_DISABLED m-unreadable'],
    );
    assert.match(outcome.reasons[1]?.detail ?? '', /state "Disabling" after 24 reads; expected Disabled/);
    assert.match(outcome.reasons[2]?.detail ?? '', /state "unreadable \(ServiceException\)"/);
    assert.deepEqual(actions(items), [
      'CONSUMER_DISABLE_FAILED m-refused',
      'CONSUMER_DISABLE_FAILED m-stuck',
      'CONSUMER_DISABLE_FAILED m-unreadable',
      'CONSUMER_DISABLED m-ok',
    ]);
    assert.equal(sleeper.requests().length, 2 * (CONSUMER_MAX_POLLS - 1), 'no sleep after the last read');
  });
});

describe('releaseBarriersAndStopExecutions (step 5)', () => {
  it('releases held barriers, stops running executions, and reports failures without stopping', async () => {
    const log = new RecordingMutationLog();
    const surfaces = new StubDiscoverySurfaces();
    const executions = new FakeDurableExecutions(surfaces, log, STACK_ID);
    executions.start('fn-a', 'arn:a1');
    executions.start('fn-a', 'arn:a2');
    executions.failStop('arn:a2');
    executions.start('fn-a', 'arn:a3');
    executions.endAfterListing('arn:a3');
    executions.failList('fn-b');
    const store = new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
    store.seed('control', { pk: 'p-held', sk: 'treatment', state: 'COMMITTED_WAITING', version: 2 });
    store.scriptReadFault('InternalServerError', { operation: 'getConsistent' });
    const barriers = new ControlTableBarrierRelease(store);
    const { items, record } = recorder();
    const outcome = await releaseBarriersAndStopExecutions(
      { treatment_partitions: ['p-bad', 'p-held', 'p-free'], durable_function_names: ['fn-a', 'fn-b'] },
      { barriers, durableExecutions: executions },
      record,
    );
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(
      outcome.reasons.map((reason) => reason.subject),
      ['p-bad', 'arn:a2', 'fn-b'],
    );
    assert.deepEqual(actions(items), [
      'SAFETY_RELEASE_FAILED p-bad',
      'SAFETY_RELEASE_APPLIED p-held',
      'SAFETY_RELEASE_NOT_HELD p-free',
      'DURABLE_STOP_APPLIED arn:a1',
      'DURABLE_STOP_FAILED arn:a2',
      'DURABLE_STOP_NOT_RUNNING arn:a3',
      'DURABLE_EXECUTIONS_LIST_FAILED fn-b',
    ]);
  });
});

describe('recordInducedTransitions (step 6)', () => {
  it('records each applied release and stop as cleanup-induced, once across runs', async () => {
    const at = '2026-10-05T12:00:00.000Z' as UtcMillis;
    const entry = (action: string, id: string): CleanupActionEntry => ({
      body: {
        step: 5,
        step_status: 'started',
        cleanup_mode: 'NORMAL',
        cleanup_induced: false,
        action,
        resource_type: 'T',
        resource_identifier: id,
        reasons: [],
      },
      occurred_at: at,
    });
    const fold = foldCleanupActions([
      entry('SAFETY_RELEASE_APPLIED', 'p1'),
      entry('SAFETY_RELEASE_APPLIED', 'p2'),
      entry('TREATMENT_SAFETY_RELEASED', 'p1'),
      entry('DURABLE_STOP_APPLIED', 'e1'),
      entry('DURABLE_STOP_APPLIED', 'e2'),
      entry('DURABLE_EXECUTION_STOPPED', 'e2'),
    ]);
    const { items, record } = recorder();
    assert.deepEqual(await recordInducedTransitions(fold, record), { status: 'succeeded', reasons: [] });
    assert.deepEqual(actions(items), ['TREATMENT_SAFETY_RELEASED p2', 'DURABLE_EXECUTION_STOPPED e1']);
    assert.ok(items.every((item) => item.cleanup_induced === true));
  });
});

describe('DLQ steps 7 and 8', () => {
  it('records each captured message once, sorted, and passes the capture status on', async () => {
    const evidence = new RecordingCleanupEvidence();
    evidence.captureMessages('m2', 'm1', 'm2');
    evidence.answer('dlq', { status: 'failed', reasons: [{ code: 'C', subject: 's', detail: 'd' }] });
    const { items, record } = recorder();
    const outcome = await captureDlqEvidence('EMERGENCY', evidence, record);
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(actions(items), ['DLQ_MESSAGE_CAPTURED m1', 'DLQ_MESSAGE_CAPTURED m2']);
    assert.deepEqual(evidence.calls(), [{ operation: 'dlq', mode: 'EMERGENCY' }]);
  });

  it('deletes only the given captured messages and reports each result', async () => {
    const dlq = new FakeDlqMessages(new RecordingMutationLog());
    dlq.add('m1', 'm2', 'm-uncaptured');
    dlq.failDelete('m2');
    const { items, record } = recorder();
    const outcome = await deleteCapturedDlqMessages(['m1', 'm2', 'm3'], dlq, record);
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(actions(items), [
      'DLQ_MESSAGE_DELETED m1',
      'DLQ_MESSAGE_ALREADY_ABSENT m3',
      'DLQ_MESSAGE_DELETE_FAILED m2',
    ]);
    assert.deepEqual(dlq.remaining(), ['m-uncaptured', 'm2']);
  });

  it('does not call the queue when nothing is pending', async () => {
    const dlq = new FakeDlqMessages(new RecordingMutationLog());
    const { items, record } = recorder();
    assert.deepEqual(await deleteCapturedDlqMessages([], dlq, record), { status: 'succeeded', reasons: [] });
    assert.deepEqual(dlq.requested(), []);
    assert.deepEqual(items, []);
  });
});
