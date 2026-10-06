// Conformance of FakeConsumerControl to the ConsumerControlPort contract (Lambda
// UpdateEventSourceMapping and its asynchronous State): Enabled → Disabling on request, Disabled
// after the scripted reads, a missing mapping absent on both calls, an idempotent repeat
// request, and scripted failures as values.
//
// Sources (RK-17): [R-aws] §6.3, `ListEventSourceMappings` `State` is one of Creating, Enabling,
// Enabled, Disabling, Disabled, Updating, Deleting; https://docs.aws.amazon.com/lambda/latest/api/API_UpdateEventSourceMapping.html
// for `Enabled=false` taking effect asynchronously through Disabling.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FakeConsumerControl } from '../../../support/cleanup/fake-consumer-control.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

describe('FakeConsumerControl conformance', () => {
  it('disables a mapping asynchronously', async () => {
    const log = new RecordingMutationLog();
    const consumers = new FakeConsumerControl(log);
    consumers.add('m', 2);
    assert.deepEqual(await consumers.readState('m'), { kind: 'state', state: 'Enabled' });
    assert.deepEqual(await consumers.requestDisable('m'), { kind: 'requested' });
    assert.deepEqual(await consumers.readState('m'), { kind: 'state', state: 'Disabling' });
    assert.deepEqual(await consumers.requestDisable('m'), { kind: 'requested' });
    assert.deepEqual(await consumers.readState('m'), { kind: 'state', state: 'Disabled' });
    assert.deepEqual(await consumers.requestDisable('m'), { kind: 'requested' });
    assert.equal(consumers.stateOf('m'), 'Disabled');
    assert.equal(log.entries().length, 3);
  });

  it('reports a missing mapping as absent', async () => {
    const consumers = new FakeConsumerControl(new RecordingMutationLog());
    assert.deepEqual(await consumers.requestDisable('gone'), { kind: 'absent' });
    assert.deepEqual(await consumers.readState('gone'), { kind: 'absent' });
    assert.equal(consumers.stateOf('gone'), undefined);
  });

  it('fails scripted requests and reads as values', async () => {
    const consumers = new FakeConsumerControl(new RecordingMutationLog());
    consumers.add('m');
    consumers.failRequest('m');
    consumers.failRead('m');
    assert.equal((await consumers.requestDisable('m')).kind, 'failed');
    assert.equal((await consumers.readState('m')).kind, 'failed');
    assert.equal(consumers.stateOf('m'), 'Enabled');
  });

  it('deletes a mapping right after an accepted request when scripted', async () => {
    const consumers = new FakeConsumerControl(new RecordingMutationLog());
    consumers.add('m');
    consumers.deleteAfterRequest('m');
    assert.deepEqual(await consumers.requestDisable('m'), { kind: 'requested' });
    assert.deepEqual(await consumers.readState('m'), { kind: 'absent' });
  });
});
