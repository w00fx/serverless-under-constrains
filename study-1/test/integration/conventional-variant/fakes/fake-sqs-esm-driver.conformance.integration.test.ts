// Conformance of FakeSqsEsmDriver to the Lambda SQS event source mapping it stands in for
// (design/aws-semantics.md §3): batch size 1, the `aws:sqs` event record, deletion only after a
// successful invocation, a failed invocation leaving the message in flight until the visibility
// timeout, and a throttle that consumes a receive without an invocation (RK-08).

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { FakeSqsEsmDriver, sqsLambdaEvent } from '../../../support/fifo-queue/fake-sqs-esm-driver.ts';
import { InMemoryFifoQueue } from '../../../support/fifo-queue/in-memory-fifo-queue.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

const ARN = 'arn:aws:sqs:us-east-1:123456789012:suc1-aaaaaaaa-conventional-source.fifo';
const VISIBILITY_MS = 60_000;

/** A function that records the events it receives and fails while `failures` remain. */
class RecordingSqsFunction {
  readonly events: { readonly event: JsonValue; readonly awsRequestId: string }[] = [];
  failures = 0;

  invoke = (event: JsonValue, context: { readonly awsRequestId: string }): Promise<void> => {
    this.events.push({ event, awsRequestId: context.awsRequestId });
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('invocation failed'));
    }
    return Promise.resolve();
  };
}

function rig(): {
  readonly time: VirtualTimeScheduler;
  readonly queue: InMemoryFifoQueue;
  readonly fn: RecordingSqsFunction;
  readonly driver: FakeSqsEsmDriver;
} {
  const time = new VirtualTimeScheduler({ wallEpochMs: 1_000 });
  const queue = new InMemoryFifoQueue({
    clock: time,
    ids: new SequentialUuidSource('99999999'),
    visibilityTimeoutMs: VISIBILITY_MS,
  });
  const fn = new RecordingSqsFunction();
  return { time, queue, fn, driver: new FakeSqsEsmDriver({ queue, invoke: fn.invoke, event_source_arn: ARN }) };
}

describe('RecordingSqsFunction (the conformance probe itself)', () => {
  it('records each call and fails exactly as many times as scripted', async () => {
    const fn = new RecordingSqsFunction();
    fn.failures = 1;
    await assert.rejects(fn.invoke({}, { awsRequestId: 'r-1' }), /invocation failed/u);
    await fn.invoke(null, { awsRequestId: 'r-2' });
    assert.deepEqual(
      fn.events.map((entry) => entry.awsRequestId),
      ['r-1', 'r-2'],
    );
  });
});

describe('FakeSqsEsmDriver (aws-semantics §3)', () => {
  it('returns empty without invoking when nothing is visible', async () => {
    const { driver, fn } = rig();
    assert.deepEqual(await driver.pollOnce(), { kind: 'empty' });
    assert.deepEqual(fn.events, []);
    assert.deepEqual(driver.requestIds(), []);
  });

  it('invokes with one aws:sqs record and deletes the message after a successful invocation', async () => {
    const { driver, fn, queue } = rig();
    const sent = queue.send({ body: 'hello', message_group_id: 'g', message_deduplication_id: 'd' });
    assert.deepEqual(await driver.pollOnce(), { kind: 'completed', message_id: sent.message_id, receive_count: 1 });
    assert.deepEqual(queue.messages(), []);
    const [call] = fn.events;
    assert.equal(call?.awsRequestId, 'lambda-request-0001');
    const records = (call.event as { readonly Records: readonly Readonly<Record<string, JsonValue>>[] }).Records;
    assert.equal(records.length, 1, 'BatchSize 1');
    assert.deepEqual(
      { ...records[0], receiptHandle: undefined },
      {
        messageId: sent.message_id,
        receiptHandle: undefined,
        body: 'hello',
        attributes: {
          ApproximateReceiveCount: '1',
          SentTimestamp: '1000',
          SenderId: 'AROAEXAMPLE:runner',
          ApproximateFirstReceiveTimestamp: '1000',
          MessageGroupId: 'g',
          MessageDeduplicationId: 'd',
        },
        messageAttributes: {},
        md5OfBody: createHash('md5').update('hello').digest('hex'),
        eventSource: 'aws:sqs',
        eventSourceARN: ARN,
        awsRegion: 'us-east-1',
      },
    );
  });

  it('leaves a failed invocation in flight until the visibility timeout, then redelivers it', async () => {
    const { driver, fn, queue, time } = rig();
    fn.failures = 1;
    const sent = queue.send({ body: 'b', message_group_id: 'g', message_deduplication_id: 'd' });
    const failed = await driver.pollOnce();
    assert.equal(failed.kind, 'failed');
    assert.match(String(failed.error), /invocation failed/u);
    assert.deepEqual(await driver.pollOnce(), { kind: 'empty' });
    await time.advanceBy(VISIBILITY_MS);
    assert.deepEqual(await driver.pollOnce(), { kind: 'completed', message_id: sent.message_id, receive_count: 2 });
    assert.deepEqual(driver.requestIds(), ['lambda-request-0001', 'lambda-request-0002']);
  });

  it('consumes a receive on a throttle without invoking (RK-08)', async () => {
    const { driver, fn, queue, time } = rig();
    const sent = queue.send({ body: 'b', message_group_id: 'g', message_deduplication_id: 'd' });
    driver.throttleNext();
    assert.deepEqual(await driver.pollOnce(), { kind: 'throttled', message_id: sent.message_id, receive_count: 1 });
    assert.deepEqual(fn.events, []);
    await time.advanceBy(VISIBILITY_MS);
    assert.deepEqual(await driver.pollOnce(), { kind: 'completed', message_id: sent.message_id, receive_count: 2 });
  });

  it('builds the event of a received message directly', () => {
    const event = sqsLambdaEvent(
      {
        message_id: 'm',
        receipt_handle: 'h',
        body: '',
        message_group_id: 'g',
        message_deduplication_id: 'd',
        approximate_receive_count: 3,
        sent_at_ms: 1,
        first_received_at_ms: 2,
      },
      ARN,
    ) as {
      readonly Records: readonly {
        readonly attributes: Readonly<Record<string, string>>;
        readonly md5OfBody: string;
      }[];
    };
    assert.equal(event.Records[0]?.attributes['ApproximateReceiveCount'], '3');
    assert.equal(event.Records[0].md5OfBody, 'd41d8cd98f00b204e9800998ecf8427e', 'the md5 of the empty body');
  });
});
