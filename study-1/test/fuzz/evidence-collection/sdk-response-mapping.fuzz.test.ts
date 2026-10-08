// Design §12.5 for the SDK response mappers (A-05; BR-RUA-037): SQS and Lambda outputs are
// untrusted input. Over arbitrary values, including hostile members (non-finite numbers, inherited
// names, boxed and exotic values, deep nesting), every mapper returns a result and never throws,
// with a bounded message; over well-formed service shapes, every mapper accepts and keeps the
// values exactly.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { mapDlqMessage } from '../../../src/evidence-collection/dlq-capture.ts';
import type { ReceivedSqsMessage } from '../../../src/evidence-collection/dlq-capture.ts';
import { mapDurableExecution, mapHistoryEvent } from '../../../src/evidence-collection/durable-sdk-mapping.ts';
import type { SdkDurableExecution, SdkHistoryEvent } from '../../../src/evidence-collection/durable-sdk-mapping.ts';
import {
  parseQueueCounterAttributes,
  QUEUE_COUNTER_ATTRIBUTES,
} from '../../../src/evidence-collection/queue-observation.ts';
import { deepTowerArbitrary } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

/** What GetQueueAttributes returns; the fuzz feeds anything in its place. */
type CounterAttributes = Parameters<typeof parseQueueCounterAttributes>[0];

/** The longest message a mapper may return: bounded quotes of the offending values plus prose. */
const MESSAGE_BOUND = 4096;

const hostileValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.anything({
    maxDepth: 3,
    withBigInt: true,
    withBoxedValues: true,
    withDate: true,
    withMap: true,
    withNullPrototype: true,
    withObjectString: true,
    withSet: true,
    withSparseArray: true,
    withTypedArray: true,
  }),
  fc.constantFrom(Infinity, -Infinity, Number.NaN, JSON.parse('1e400') as number, -0, 2 ** 53, new Date(Number.NaN)),
  deepTowerArbitrary(5_000),
);

const MEMBER_NAMES = [
  'MessageId',
  'Body',
  'MD5OfBody',
  'Attributes',
  'ApproximateReceiveCount',
  'SentTimestamp',
  'MessageGroupId',
  'SequenceNumber',
  ...Object.values(QUEUE_COUNTER_ATTRIBUTES),
  'DurableExecutionArn',
  'DurableExecutionName',
  'Status',
  'StartTimestamp',
  'EndTimestamp',
  'Version',
  'EventType',
  'EventId',
  'EventTimestamp',
  'StepFailedDetails',
  'RetryDetails',
  'toString',
  'valueOf',
  '__proto__',
  'constructor',
] as const;

/** An object of hostile members under the names the mappers read, own or inherited. */
const hostileHolder: fc.Arbitrary<unknown> = fc
  .record({
    own: fc.dictionary(fc.constantFrom(...MEMBER_NAMES), hostileValue, { maxKeys: 8 }),
    inherited: fc.dictionary(fc.constantFrom(...MEMBER_NAMES), hostileValue, { maxKeys: 4 }),
  })
  .map(({ own, inherited }) => Object.assign(Object.create(inherited) as object, own));

const untrusted = fc.oneof(hostileValue, hostileHolder);

function assertTotal(run: () => { readonly ok: boolean; readonly error?: unknown }): void {
  const result = run();
  if (!result.ok) {
    assert.equal(typeof result.error, 'string');
    assert.ok(
      (result.error as string).length <= MESSAGE_BOUND,
      `message of ${String((result.error as string).length)} chars`,
    );
  }
}

describe('SDK response mappers are total over untrusted values', () => {
  it('mapDlqMessage, parseQueueCounterAttributes, mapDurableExecution and mapHistoryEvent never throw', () => {
    fc.assert(
      fc.property(untrusted, (value) => {
        assertTotal(() => mapDlqMessage(value as ReceivedSqsMessage));
        assertTotal(() => mapDlqMessage({ MessageId: 'm', Body: 'b', Attributes: value }));
        assertTotal(() => parseQueueCounterAttributes(value as CounterAttributes));
        assertTotal(() => mapDurableExecution(value as SdkDurableExecution));
        assertTotal(() => mapHistoryEvent(value as SdkHistoryEvent));
        assertTotal(() =>
          mapHistoryEvent(
            Object.assign({ EventType: 'StepFailed', EventTimestamp: new Date(0) }, { StepFailedDetails: value }),
          ),
        );
      }),
      fuzzParameters(),
    );
  });

  it('refuses every member that is only inherited', () => {
    const inheritedMessage = Object.create({
      MessageId: 'm',
      Body: 'b',
      MD5OfBody: '00000000000000000000000000000000',
    }) as ReceivedSqsMessage;
    assert.equal(mapDlqMessage(inheritedMessage).ok, false);
    assert.equal(
      parseQueueCounterAttributes(Object.create({ ApproximateNumberOfMessages: '1' }) as CounterAttributes).ok,
      false,
    );
  });
});

const epochMs = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2099, 11, 31) });
const nonEmpty = fc.string({ minLength: 1, maxLength: 40 });

describe('SDK response mappers keep well-formed service shapes exactly', () => {
  it('queue counters round-trip through their decimal strings', () => {
    fc.assert(
      fc.property(fc.tuple(fc.nat(), fc.nat(), fc.nat()), ([visible, inFlight, delayed]) => {
        const parsed = parseQueueCounterAttributes({
          [QUEUE_COUNTER_ATTRIBUTES.visible]: String(visible),
          [QUEUE_COUNTER_ATTRIBUTES.in_flight]: String(inFlight),
          [QUEUE_COUNTER_ATTRIBUTES.delayed]: String(delayed),
        });
        assert.deepEqual(parsed, { ok: true, value: { visible, in_flight: inFlight, delayed } });
      }),
      fuzzParameters(),
    );
  });

  it('a well-formed DLQ message maps with every attribute kept', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: nonEmpty,
          body: fc.string({ unit: 'binary', maxLength: 200 }),
          count: fc.integer({ min: 1, max: 1_000_000 }),
          firstReceive: epochMs,
          sent: epochMs,
          group: nonEmpty,
          dedup: nonEmpty,
          sequence: fc.stringMatching(/^[0-9]{1,30}$/),
        }),
        (message) => {
          const mapped = mapDlqMessage({
            MessageId: message.id,
            Body: message.body,
            MD5OfBody: 'd41d8cd98f00b204e9800998ecf8427e',
            Attributes: {
              ApproximateReceiveCount: String(message.count),
              ApproximateFirstReceiveTimestamp: String(message.firstReceive),
              SentTimestamp: String(message.sent),
              MessageGroupId: message.group,
              MessageDeduplicationId: message.dedup,
              SequenceNumber: message.sequence,
            },
          });
          assert.ok(mapped.ok, mapped.ok ? '' : mapped.error);
          assert.equal(mapped.value.message_id, message.id);
          assert.equal(mapped.value.body, message.body);
          assert.equal(mapped.value.approximate_receive_count, message.count);
          assert.equal(Date.parse(mapped.value.sent_timestamp), message.sent);
          assert.equal(mapped.value.message_group_id, message.group);
          assert.equal(mapped.value.sequence_number, message.sequence);
        },
      ),
      fuzzParameters(),
    );
  });

  it('a well-formed execution and history event map with their instants kept', () => {
    fc.assert(
      fc.property(
        nonEmpty,
        fc.constantFrom('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'STOPPED'),
        epochMs,
        fc.option(epochMs, { nil: undefined }),
        fc.stringMatching(/^[A-Z][A-Za-z]{0,30}$/),
        fc.nat(),
        (arn, status, startMs, endMs, eventType, eventId) => {
          const execution = mapDurableExecution({
            DurableExecutionArn: arn,
            DurableExecutionName: 'n',
            Status: status,
            StartTimestamp: new Date(startMs),
            ...(endMs === undefined ? {} : { EndTimestamp: new Date(endMs) }),
          });
          assert.ok(execution.ok, execution.ok ? '' : execution.error);
          assert.equal(Date.parse(execution.value.started_at), startMs);
          assert.equal(execution.value.ended_at === undefined, endMs === undefined);
          const event = mapHistoryEvent({ EventType: eventType, EventId: eventId, EventTimestamp: new Date(startMs) });
          assert.ok(event.ok, event.ok ? '' : event.error);
          assert.equal(event.value.event_type, eventType);
          assert.equal(event.value.history_event_id, eventId);
        },
      ),
      fuzzParameters(),
    );
  });
});
