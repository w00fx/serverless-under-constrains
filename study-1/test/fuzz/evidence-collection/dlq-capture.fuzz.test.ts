// Design §12.5 for the DLQ capture (design §5.3, §7; BR-RUA-032, BR-RUA-037): over arbitrary queue
// contents (the trial's and other trials' messages, malformed entries), receive modes and failed
// receives, the capture is a valid `dlq_snapshot`, snapshots only the trial's own messages, never
// reports a correlated id it did not capture, stops within the round limit, and is complete
// exactly when no failure was recorded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { captureDlq, DLQ_RECEIVE_ROUND_LIMIT } from '../../../src/evidence-collection/dlq-capture.ts';
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
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const DLQ = {
  queue_url: 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-dlq.fifo',
  queue_name: 'suc1-dlq.fifo',
};
const OTHER_TRIAL = '00000000-0000-4000-8000-000000000204';

const queuedMessage: fc.Arbitrary<ReceivedSqsMessage> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .record({ id: fc.nat(40), mine: fc.boolean() })
      .map(({ id, mine }) => sqsMessage({ id: `m${String(id)}`, group: mine ? TRIAL_ID : OTHER_TRIAL })),
  },
  {
    weight: 1,
    arbitrary: fc.record({ MessageId: fc.string({ maxLength: 4 }), Attributes: fc.jsonValue({ maxDepth: 1 }) }),
  },
);

describe('captureDlq', () => {
  it('snapshots only the trial messages, within the round limit, complete iff nothing failed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(queuedMessage, { maxLength: 40 }),
        fc.constantFrom<'head' | 'rotating'>('head', 'rotating'),
        fc.option(fc.integer({ min: 1, max: DLQ_RECEIVE_ROUND_LIMIT }), { nil: undefined }),
        async (messages, mode, failingReceive) => {
          const receiver = new ScriptedDlqReceiver(mode);
          for (const message of messages) {
            receiver.enqueue(message);
          }
          if (failingReceive !== undefined) {
            receiver.scriptFailure('ThrottlingException', failingReceive);
          }
          const capture = await captureDlq(receiver, DLQ, TRIAL_SCOPE, collectionClock());
          assertValidRecord(capture.record, 'dlq_snapshot');
          assert.ok(receiver.receiveCount() <= DLQ_RECEIVE_ROUND_LIMIT);
          const captured = new Set(capture.captured_message_ids);
          assert.ok(capture.correlated_message_ids.every((id) => captured.has(id)));
          const snapshot = capture.record['messages'] as readonly JsonObject[];
          assert.ok(snapshot.every((message) => message['message_group_id'] === TRIAL_ID));
          assert.deepEqual(
            snapshot.map((message) => message['message_id']),
            capture.correlated_message_ids,
          );
          assert.equal(capture.receive_complete, capture.failures.length === 0);
          assert.equal(capture.record['receive_complete'], capture.receive_complete);
        },
      ),
      fuzzParameters(),
    );
  });
});
