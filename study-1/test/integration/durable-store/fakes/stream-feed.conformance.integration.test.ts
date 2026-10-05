// Conformance of StreamFeed with the DynamoDB Streams event source mapping it emulates
// (design §12.2, §9.5; RK-17). Sources: Streams.html (one record per item modification,
// NEW_IMAGE), with-ddb.html (at-least-once, polling start lag, TRIM_HORIZON),
// Streams.Lambda.Tutorial2.html and invocation-eventfiltering.html (F-2 filter on eventName and
// dynamodb), services-dynamodb-errors.html (bounded retries, on-failure metadata).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

import type { StoredItem, WriteAction } from '../../../../src/durable-store/item-store-port.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import { SHARD_ID, StreamFeed } from '../../../support/durable-store/stream-feed.ts';
import type { StreamFeedOptions } from '../../../support/durable-store/stream-feed.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

const PK = 'run#trial';
const TOKEN = '21111111-2222-4333-8444-555555555555' as Uuid4;
// The controller filter of design §9.5, verbatim.
const CALLER_TIMEOUT_FILTER =
  '{"eventName":["INSERT"],"dynamodb":{"NewImage":{"record_type":{"S":["caller_timeout_recorded"]}}}}';

interface Harness {
  readonly time: VirtualTimeScheduler;
  readonly store: InMemoryItemStore;
  readonly delivered: DynamoDBRecord[];
  readonly feed: StreamFeed;
}

function harness(
  options: Partial<Omit<StreamFeedOptions, 'source' | 'table' | 'scheduler' | 'clock' | 'consumer'>> = {},
  failures: { remaining: number } = { remaining: 0 },
): Harness {
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12) });
  const store = new InMemoryItemStore({ clock: time });
  const delivered: DynamoDBRecord[] = [];
  const consumer = (event: DynamoDBStreamEvent): Promise<void> => {
    delivered.push(...event.Records);
    if (failures.remaining > 0) {
      failures.remaining -= 1;
      return Promise.reject(new Error('consumer failed'));
    }
    return Promise.resolve();
  };
  const feed = new StreamFeed({
    source: store,
    table: 'caller_journal',
    scheduler: time,
    clock: time,
    consumer,
    ...options,
  });
  return { time, store, delivered, feed };
}

function event(sk: string, recordType: string): WriteAction {
  const item: StoredItem = { pk: PK, sk, record_type: recordType, schema_version: 1 };
  return { kind: 'put', table: 'caller_journal', item, condition: { kind: 'item_absent' } };
}

function sks(records: readonly DynamoDBRecord[]): readonly (string | undefined)[] {
  return records.map((record) => record.dynamodb?.Keys?.['sk']?.S);
}

describe('StreamFeed record shape and order', () => {
  it('delivers one record per batch, INSERT then MODIFY, with NEW_IMAGE in the Lambda event shape', async () => {
    const { time, store, delivered, feed } = harness();
    feed.enable();
    await store.write(event('e#1', 'attempt_registered'));
    await store.write({
      kind: 'update',
      table: 'caller_journal',
      key: { pk: PK, sk: 'e#1' },
      set: { note: 'x' },
      condition: { kind: 'attribute_equals', name: 'record_type', value: 'attempt_registered' },
    });
    await time.advanceUntilIdle();
    assert.equal(delivered.length, 2);
    assert.deepEqual(delivered[0], {
      eventID: '00000000000000000000000000000001',
      eventName: 'INSERT',
      eventVersion: '1.1',
      eventSource: 'aws:dynamodb',
      awsRegion: 'us-east-1',
      dynamodb: {
        ApproximateCreationDateTime: Date.UTC(2026, 9, 5, 12) / 1000,
        Keys: { pk: { S: PK }, sk: { S: 'e#1' } },
        NewImage: {
          pk: { S: PK },
          sk: { S: 'e#1' },
          record_type: { S: 'attempt_registered' },
          schema_version: { N: '1' },
        },
        SequenceNumber: '000000000000000000001',
        // The emulator's stand-in for record size: UTF-8 bytes of the JSON Keys plus NewImage.
        SizeBytes: 150,
        StreamViewType: 'NEW_IMAGE',
      },
      eventSourceARN: 'arn:aws:dynamodb:us-east-1:000000000000:table/caller_journal/stream',
    });
    const modify = delivered[1];
    assert.ok(modify?.dynamodb !== undefined);
    assert.equal(modify.eventName, 'MODIFY');
    assert.equal(modify.dynamodb.NewImage?.['note']?.S, 'x');
    assert.equal(modify.dynamodb.OldImage, undefined);
    assert.equal(modify.dynamodb.SequenceNumber, '000000000000000000002');
  });

  it('emits one record per item of a transaction, in action order, with no grouping', async () => {
    const { time, store, delivered, feed } = harness({ streamArn: 'arn:custom', region: 'sa-east-1' });
    feed.enable();
    await store.transact([event('e#2', 'a'), event('e#1', 'b')], TOKEN);
    await time.advanceUntilIdle();
    assert.deepEqual(sks(delivered), ['e#2', 'e#1']);
    assert.deepEqual(
      delivered.map((record) => [record.eventSourceARN, record.awsRegion]),
      [
        ['arn:custom', 'sa-east-1'],
        ['arn:custom', 'sa-east-1'],
      ],
    );
  });

  it('never reorders: a delayed record holds back every later one', async () => {
    const { time, store, delivered, feed } = harness();
    feed.enable();
    await time.advanceUntilIdle();
    feed.delay(16_000);
    await store.write(event('e#1', 'a'));
    await store.write(event('e#2', 'b'));
    await time.advanceBy(15_999);
    assert.deepEqual(delivered, []);
    assert.equal(feed.pendingCount(), 2);
    await time.advanceBy(1);
    assert.deepEqual(sks(delivered), ['e#1', 'e#2']);
    assert.equal(feed.pendingCount(), 0);
  });
});

describe('StreamFeed readiness', () => {
  it('delivers nothing before enable, and records written during the readiness lag arrive after it (TRIM_HORIZON)', async () => {
    const { time, store, delivered, feed } = harness({ readinessLagMs: 120_000 });
    await store.write(event('e#1', 'a'));
    await time.advanceBy(1_000);
    assert.equal(feed.isEnabled(), false);
    assert.deepEqual(delivered, []);
    feed.enable();
    assert.equal(feed.isEnabled(), true);
    await store.write(event('e#2', 'b'));
    await time.advanceBy(119_999);
    assert.equal(feed.isPolling(), false);
    assert.deepEqual(delivered, []);
    await time.advanceBy(1);
    assert.equal(feed.isPolling(), true);
    assert.deepEqual(sks(delivered), ['e#1', 'e#2']);
  });

  it('refuses a second enable and invalid settings', () => {
    const { feed } = harness();
    feed.enable();
    assert.throws(() => {
      feed.enable();
    }, /enable\(\) called twice/);
    assert.throws(() => harness({ maxRetryAttempts: -1 }), /maxRetryAttempts -1; expected a nonnegative safe integer/);
    assert.throws(() => harness({ readinessLagMs: 1.5 }), /readinessLagMs 1.5; expected a nonnegative safe integer/);
    assert.throws(() => {
      feed.delay(-1);
    }, /delay -1; expected a nonnegative safe integer/);
  });
});

describe('StreamFeed filtering (F-2)', () => {
  it('delivers only INSERTs of caller_timeout_recorded and skips everything else', async () => {
    const { time, store, delivered, feed } = harness({ filters: [CALLER_TIMEOUT_FILTER] });
    feed.enable();
    await store.write(event('e#1', 'attempt_registered'));
    await store.write(event('e#2', 'caller_timeout_recorded'));
    await store.write({
      kind: 'update',
      table: 'caller_journal',
      key: { pk: PK, sk: 'e#2' },
      set: { touched: true },
      condition: { kind: 'item_absent' },
    });
    await store.write({
      kind: 'update',
      table: 'caller_journal',
      key: { pk: PK, sk: 'e#2' },
      set: { touched: true },
      condition: { kind: 'attribute_equals', name: 'record_type', value: 'caller_timeout_recorded' },
    });
    await store.write(event('e#3', 'CALLER_TIMEOUT_RECORDED'));
    await time.advanceUntilIdle();
    assert.deepEqual(sks(delivered), ['e#2']);
    assert.equal(feed.skippedCount(), 3);
  });

  it('combines patterns with OR; a nested pattern never matches a list attribute', async () => {
    const { time, store, delivered, feed } = harness({
      filters: [
        { dynamodb: { NewImage: { record_type: { S: ['a'] } } } },
        { dynamodb: { Keys: { sk: { S: ['e#3'] } } } },
        { dynamodb: { NewImage: { tags: { L: { S: ['x'] } } } } },
      ],
    });
    feed.enable();
    await store.write(event('e#1', 'a'));
    await store.write(event('e#2', 'b'));
    await store.write(event('e#3', 'c'));
    await store.write({ kind: 'put', table: 'caller_journal', item: { pk: PK, sk: 'e#4', tags: ['x'] } });
    await time.advanceUntilIdle();
    assert.deepEqual(sks(delivered), ['e#1', 'e#3']);
    assert.equal(feed.skippedCount(), 2);
  });

  it('refuses more than five patterns and operators beyond exact match', () => {
    const many = Array.from({ length: 6 }, () => CALLER_TIMEOUT_FILTER);
    assert.throws(() => harness({ filters: many }), /6 filter patterns; expected at most 5/);
    assert.throws(
      () => harness({ filters: ['{"eventName":[{"prefix":"IN"}]}'] }),
      /filter rule at \$\.eventName is \[\{"prefix":"IN"\}\]; expected a non-empty array of exact-match scalars/,
    );
    assert.throws(() => harness({ filters: ['{"eventName":[]}'] }), /filter rule at \$\.eventName is \[\]/);
    assert.throws(() => harness({ filters: ['{"eventName":"INSERT"}'] }), /filter rule at \$\.eventName is "INSERT"/);
    assert.throws(() => harness({ filters: ['{}'] }), /filter pattern \{\}; expected a non-empty JSON object/);
    assert.throws(() => harness({ filters: ['[1]'] }), /filter pattern \[1\]; expected a non-empty JSON object/);
  });
});

describe('StreamFeed at-least-once delivery and errors', () => {
  it('duplicateNext re-delivers the next record with the same eventID', async () => {
    const { time, store, delivered, feed } = harness();
    feed.enable();
    feed.duplicateNext();
    await store.write(event('e#1', 'a'));
    await store.write(event('e#2', 'b'));
    await time.advanceUntilIdle();
    assert.deepEqual(sks(delivered), ['e#1', 'e#1', 'e#2']);
    assert.equal(delivered[0]?.eventID, delivered[1]?.eventID);
    assert.deepEqual(
      feed.deliveries().map((entry) => [entry.event_id.slice(-1), entry.attempt, entry.outcome]),
      [
        ['1', 1, 'succeeded'],
        ['1', 2, 'succeeded'],
        ['2', 1, 'succeeded'],
      ],
    );
  });

  it('retries a failing record, blocking the shard, then succeeds', async () => {
    const failures = { remaining: 1 };
    const { time, store, delivered, feed } = harness({}, failures);
    feed.enable();
    await store.write(event('e#1', 'a'));
    await store.write(event('e#2', 'b'));
    await time.advanceUntilIdle();
    assert.deepEqual(sks(delivered), ['e#1', 'e#1', 'e#2']);
    assert.deepEqual(feed.onFailureRecords(), []);
  });

  it('after MaximumRetryAttempts the record goes to the on-failure destination as metadata and the shard advances', async () => {
    const failures = { remaining: 3 };
    const { time, store, delivered, feed } = harness({}, failures);
    feed.enable();
    await store.write(event('e#1', 'a'));
    await store.write(event('e#2', 'b'));
    await time.advanceUntilIdle();
    assert.deepEqual(sks(delivered), ['e#1', 'e#1', 'e#1', 'e#2']);
    assert.deepEqual(feed.onFailureRecords(), [
      {
        shard_id: SHARD_ID,
        start_sequence_number: '000000000000000000001',
        end_sequence_number: '000000000000000000001',
        batch_size: 1,
        attempts: 3,
      },
    ]);
    assert.deepEqual(
      feed.deliveries().map((entry) => entry.outcome),
      ['failed', 'failed', 'failed', 'succeeded'],
    );
  });

  it('with zero retries a failure is discarded at once', async () => {
    const failures = { remaining: 1 };
    const { time, store, feed } = harness({ maxRetryAttempts: 0 }, failures);
    feed.enable();
    await store.write(event('e#1', 'a'));
    await time.advanceUntilIdle();
    assert.equal(feed.onFailureRecords()[0]?.attempts, 1);
  });

  it('close stops receiving records from the table', async () => {
    const { time, store, delivered, feed } = harness();
    feed.enable();
    feed.close();
    await store.write(event('e#1', 'a'));
    await time.advanceUntilIdle();
    assert.deepEqual(delivered, []);
    assert.equal(feed.pendingCount(), 0);
  });
});
