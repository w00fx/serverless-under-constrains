// Conformance of ScriptedQueueCounterReader (design §12.2): its reads have exactly the shapes the
// real SQS binding produces through a real SQSClient — the counters of a queue, a missing queue as
// QueueDoesNotExist, and a service error as its bare code. `scriptFailure` queues per URL, which
// the real binding cannot be told to do; it emulates the service failing that one read.
//
// Sources (RK-17): [R-aws] §3 "Settlement polling, GetQueueAttributes" (the three approximate
// counters `ApproximateNumberOfMessages`, `…NotVisible`, `…Delayed`, lagging at least a minute,
// so they never establish settlement alone).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSqsQueueCounterReader } from '../../../../src/evidence-collection/aws/sqs-collector.ts';
import { ScriptedQueueCounterReader } from '../../../support/evidence-collection/scripted-queue-counter-reader.ts';
import { ScriptedSqsClient } from '../../../support/evidence-collection/scripted-sqs-client.ts';

const QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-source.fifo';
const MISSING_URL = 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-gone.fifo';

describe('ScriptedQueueCounterReader conformance', () => {
  it('reads counters, a missing queue and a throttle exactly as the real binding does', async () => {
    const sqs = new ScriptedSqsClient();
    sqs.setQueueAttributes(QUEUE_URL, {
      ApproximateNumberOfMessages: '3',
      ApproximateNumberOfMessagesNotVisible: '1',
      ApproximateNumberOfMessagesDelayed: '2',
    });
    const real = createSqsQueueCounterReader(sqs.client);
    const fake = new ScriptedQueueCounterReader();
    fake.setCounters(QUEUE_URL, { visible: 3, in_flight: 1, delayed: 2 });

    assert.deepEqual(await fake.read(QUEUE_URL), await real.read(QUEUE_URL));
    assert.deepEqual(await fake.read(MISSING_URL), await real.read(MISSING_URL));
    sqs.scriptError('ThrottlingException');
    fake.scriptFailure(QUEUE_URL, 'ThrottlingException');
    assert.deepEqual(await fake.read(QUEUE_URL), await real.read(QUEUE_URL));
  });

  it('fails one read per scripted failure, in order, and records every URL read', async () => {
    const fake = new ScriptedQueueCounterReader();
    fake.setCounters(QUEUE_URL, { visible: 0, in_flight: 0, delayed: 0 });
    fake.scriptFailure(QUEUE_URL, 'First');
    fake.scriptFailure(QUEUE_URL, 'Second');
    assert.deepEqual(await fake.read(QUEUE_URL), { ok: false, error: { code: 'First' } });
    assert.deepEqual(await fake.read(QUEUE_URL), { ok: false, error: { code: 'Second' } });
    assert.deepEqual(await fake.read(QUEUE_URL), { ok: true, value: { visible: 0, in_flight: 0, delayed: 0 } });
    assert.deepEqual(fake.reads(), [QUEUE_URL, QUEUE_URL, QUEUE_URL]);
  });

  it('returns a copy, so a caller cannot change the scripted counters', async () => {
    const fake = new ScriptedQueueCounterReader();
    fake.setCounters(QUEUE_URL, { visible: 1, in_flight: 0, delayed: 0 });
    const first = await fake.read(QUEUE_URL);
    assert.ok(first.ok);
    (first.value as { visible: number }).visible = 99;
    assert.deepEqual(await fake.read(QUEUE_URL), { ok: true, value: { visible: 1, in_flight: 0, delayed: 0 } });
  });
});
