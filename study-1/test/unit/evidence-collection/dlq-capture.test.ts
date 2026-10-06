// The conditional DLQ capture (design §5.3, §7; BR-RUA-032, BR-RUA-037, BR-RUA-048 step 7):
// receive without delete until a round brings nothing unseen, snapshot the trial's own messages,
// and report every captured id so settlement can compare them with the DLQ counters.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { captureDlq, DLQ_RECEIVE_ROUND_LIMIT, mapDlqMessage } from '../../../src/evidence-collection/dlq-capture.ts';
import type { ReceivedSqsMessage } from '../../../src/evidence-collection/dlq-capture.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  assertValidRecord,
  collectionClock,
  sqsMessage,
  TRIAL_ID,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDlqReceiver } from '../../support/evidence-collection/scripted-dlq-receiver.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';

const DLQ = {
  queue_url: 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-dlq.fifo',
  queue_name: 'suc1-dlq.fifo',
};
const OTHER_TRIAL = '00000000-0000-4000-8000-000000000204';

function withAttribute(name: string, value: unknown): ReceivedSqsMessage {
  const message = sqsMessage({ id: 'm1', group: TRIAL_ID });
  return { ...message, Attributes: { ...(message.Attributes as object), [name]: value } };
}

describe('mapDlqMessage', () => {
  it('maps the SQS shape to the snapshot entry, with the body digest and UTC timestamps', () => {
    const body = '{"trial_id":"x"}\n';
    const mapped = mapDlqMessage({ ...sqsMessage({ id: 'm1', group: TRIAL_ID }), Body: body });
    assert.deepEqual(mapped, {
      ok: true,
      value: {
        message_id: 'm1',
        body,
        body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
        md5_of_body: '5041925b48aa53c3d3044a97ee5027f1',
        approximate_receive_count: 2,
        approximate_first_receive_timestamp: '2026-10-05T12:35:05.400Z',
        sent_timestamp: '2026-10-05T12:35:05.000Z',
        message_group_id: TRIAL_ID,
        message_deduplication_id: TRIAL_ID,
        sequence_number: '18000000000002100000',
      },
    });
  });

  it('refuses each malformed top-level member', () => {
    const base = sqsMessage({ id: 'm1', group: TRIAL_ID });
    const cases: readonly [ReceivedSqsMessage, RegExp][] = [
      [{ ...base, MessageId: '' }, /^MessageId is ""/],
      [{ ...base, MessageId: undefined }, /^MessageId is absent/],
      [{ ...base, Body: 7 }, /^Body is 7; expected a string$/],
      [{ ...base, MD5OfBody: 'ABCDEF' }, /^MD5OfBody is "ABCDEF"/],
      [{ ...base, MD5OfBody: undefined }, /^MD5OfBody is absent/],
      [{ ...base, Attributes: undefined }, /^Attributes are absent/],
    ];
    for (const [message, expected] of cases) {
      const mapped = mapDlqMessage(message);
      assert.match(mapped.ok ? '' : mapped.error, expected);
    }
  });

  it('refuses each malformed attribute', () => {
    const cases: readonly [string, unknown][] = [
      ['ApproximateReceiveCount', '0'],
      ['ApproximateReceiveCount', 2],
      ['ApproximateFirstReceiveTimestamp', '-5'],
      ['SentTimestamp', '253402300800000'],
      ['MessageGroupId', ''],
      ['MessageDeduplicationId', 5],
      ['SequenceNumber', '12a'],
      ['SequenceNumber', 18],
    ];
    for (const [name, value] of cases) {
      const mapped = mapDlqMessage(withAttribute(name, value));
      assert.match(mapped.ok ? '' : mapped.error, /^Attributes are \{.*; expected ApproximateReceiveCount >= 1/, name);
    }
  });

  it('reads only own members and stays total on hostile values (A-05)', () => {
    const inherited = Object.create(sqsMessage({ id: 'm1', group: TRIAL_ID })) as ReceivedSqsMessage;
    assert.equal(mapDlqMessage(inherited).ok, false);
    const hostile = JSON.parse(
      '{"MessageId":"m","Body":"b","MD5OfBody":"5041925b48aa53c3d3044a97ee5027f1","Attributes":{"__proto__":{"ApproximateReceiveCount":"2"}}}',
    ) as ReceivedSqsMessage;
    assert.equal(mapDlqMessage(hostile).ok, false);
    const deep = mapDlqMessage({
      ...sqsMessage({ id: 'm', group: TRIAL_ID }),
      Attributes: parsedTower('object', DEEP_NESTING),
    });
    assert.equal(deep.ok, false);
    const infinite = mapDlqMessage(withAttribute('ApproximateReceiveCount', JSON.parse('1e400')));
    assert.equal(infinite.ok, false);
  });
});

describe('captureDlq', () => {
  it('snapshots the trial messages and reports every captured id, without deleting', async () => {
    const dlq = new ScriptedDlqReceiver();
    dlq.enqueue(sqsMessage({ id: 'earlier', group: OTHER_TRIAL }));
    dlq.enqueue(sqsMessage({ id: 'mine', group: TRIAL_ID }));
    const capture = await captureDlq(dlq, DLQ, TRIAL_SCOPE, collectionClock());
    assertValidRecord(capture.record, 'dlq_snapshot');
    assert.deepEqual(capture.correlated_message_ids, ['mine']);
    assert.deepEqual(capture.captured_message_ids, ['earlier', 'mine']);
    assert.equal(capture.receive_complete, true);
    assert.equal(capture.record['receive_complete'], true);
    assert.deepEqual(
      (capture.record['messages'] as readonly JsonObject[]).map((message) => message['message_id']),
      ['mine'],
    );
    assert.equal(capture.record['queue_name'], 'suc1-dlq.fifo');
    assert.equal(dlq.receiveCount(), 2, 'the second round sees nothing unseen and ends the capture');
  });

  it('is complete on an empty queue after one receive', async () => {
    const dlq = new ScriptedDlqReceiver();
    const capture = await captureDlq(dlq, DLQ, TRIAL_SCOPE, collectionClock());
    assert.equal(capture.receive_complete, true);
    assert.deepEqual(capture.record['messages'], []);
    assert.equal(dlq.receiveCount(), 1);
    assertValidRecord(capture.record);
  });

  it('records a failed receive and stays incomplete', async () => {
    const dlq = new ScriptedDlqReceiver();
    dlq.enqueue(sqsMessage({ id: 'mine', group: TRIAL_ID }));
    dlq.scriptFailure('KmsThrottled');
    const capture = await captureDlq(dlq, DLQ, TRIAL_SCOPE, collectionClock());
    assert.equal(capture.receive_complete, false);
    assert.deepEqual(capture.correlated_message_ids, []);
    assert.deepEqual(
      capture.failures.map((failure) => failure.code),
      ['DLQ_RECEIVE_FAILED'],
    );
    assertValidRecord(capture.record);
  });

  it('keeps what an earlier round captured when a later receive fails', async () => {
    const dlq = new ScriptedDlqReceiver('rotating');
    for (let serial = 0; serial < 12; serial += 1) {
      dlq.enqueue(sqsMessage({ id: `m${String(serial)}`, group: TRIAL_ID }));
    }
    dlq.scriptFailure('ThrottlingException', 2);
    const capture = await captureDlq(dlq, DLQ, TRIAL_SCOPE, collectionClock());
    assert.equal(capture.correlated_message_ids.length, 10);
    assert.equal(capture.receive_complete, false);
    assert.match(capture.failures[0]?.detail ?? '', /at page 2 failed with ThrottlingException/);
    assertValidRecord(capture.record);
  });

  it('drains a queue wider than one batch over several rounds', async () => {
    const dlq = new ScriptedDlqReceiver('rotating');
    for (let serial = 0; serial < 12; serial += 1) {
      dlq.enqueue(sqsMessage({ id: `m${String(serial)}`, group: TRIAL_ID }));
    }
    const capture = await captureDlq(dlq, DLQ, TRIAL_SCOPE, collectionClock());
    assert.equal(capture.correlated_message_ids.length, 12);
    assert.equal(capture.receive_complete, true);
  });

  it('records a malformed message as a failure, leaves it uncaptured, and stays incomplete', async () => {
    const dlq = new ScriptedDlqReceiver();
    dlq.enqueue({ ...sqsMessage({ id: 'bad', group: TRIAL_ID }), MD5OfBody: 'nope' });
    dlq.enqueue(sqsMessage({ id: 'good', group: TRIAL_ID }));
    const capture = await captureDlq(dlq, DLQ, TRIAL_SCOPE, collectionClock());
    assert.deepEqual(capture.captured_message_ids, ['good']);
    assert.equal(capture.receive_complete, false);
    // The malformed message comes back on both rounds; it is reported once (WP-25 review).
    assert.equal(dlq.receiveCount(), 2);
    assert.deepEqual(
      capture.failures.map((failure) => failure.code),
      ['DLQ_MESSAGE_MALFORMED'],
    );
    assert.match(capture.failures[0]?.detail ?? '', /^dlq suc1-dlq\.fifo returned message "bad": MD5OfBody is "nope"/);
  });

  it(`stops after ${String(DLQ_RECEIVE_ROUND_LIMIT)} rounds that keep bringing unseen messages`, async () => {
    const dlq = new ScriptedDlqReceiver('rotating');
    for (let serial = 0; serial < 10 * DLQ_RECEIVE_ROUND_LIMIT + 5; serial += 1) {
      dlq.enqueue(sqsMessage({ id: `m${String(serial)}`, group: TRIAL_ID }));
    }
    const capture = await captureDlq(dlq, DLQ, TRIAL_SCOPE, collectionClock());
    assert.equal(dlq.receiveCount(), DLQ_RECEIVE_ROUND_LIMIT);
    assert.equal(capture.receive_complete, false);
    assert.equal(capture.captured_message_ids.length, 10 * DLQ_RECEIVE_ROUND_LIMIT);
    assert.deepEqual(
      capture.failures.map((failure) => failure.code),
      ['DLQ_RECEIVE_ROUNDS_EXHAUSTED'],
    );
  });
});
