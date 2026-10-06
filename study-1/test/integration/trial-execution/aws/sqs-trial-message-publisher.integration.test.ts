// The SQS binding of the trial message publisher (BR-RUA-020, BR-RUA-036, D-29; design §9.4): a
// real SQSClient built by the collector's factory serializes, signs, checks the body MD5 and
// deserializes through a scripted HTTP layer, so the test sees the exact SendMessage on the wire
// and the outcome of every answer. One publish is one request (maxAttempts 1): a 5xx is not
// retried, and only a definitive 4xx client fault is a rejection.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { COLLECTOR_SQS_CLIENT_OPTIONS } from '../../../../src/evidence-collection/aws/sqs-collector.ts';
import { createSqsTrialMessagePublisher } from '../../../../src/trial-execution/aws/sqs-trial-message-publisher.ts';
import { SEND_OUTPUT_INCOMPLETE } from '../../../../src/trial-execution/send-failure-classification.ts';
import type { TrialMessageSend } from '../../../../src/trial-execution/trial-execution-ports.ts';
import { operationOf, ScriptedSqsSendClient } from '../support/scripted-sqs-send-client.ts';

const TRIAL_ID = '6d3f2a1b-7c4e-4f5a-9b8c-0d1e2f3a4b5c';
const SEND: TrialMessageSend = {
  queue_url: 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-p-conventional-source.fifo',
  body: '{"record_type":"trial_message","trial_id":"6d3f2a1b-7c4e-4f5a-9b8c-0d1e2f3a4b5c"}',
  message_group_id: TRIAL_ID,
  message_deduplication_id: TRIAL_ID,
};

function setup(): {
  readonly sqs: ScriptedSqsSendClient;
  readonly publish: () => ReturnType<ReturnType<typeof createSqsTrialMessagePublisher>['publish']>;
} {
  const sqs = new ScriptedSqsSendClient();
  const publisher = createSqsTrialMessagePublisher(sqs.client);
  return { sqs, publish: () => publisher.publish(SEND) };
}

describe('createSqsTrialMessagePublisher', () => {
  it('sends one FIFO SendMessage with the trial id as group and deduplication id', async () => {
    const { sqs, publish } = setup();
    sqs.script({ kind: 'accept' });
    await publish();
    const [request, ...others] = sqs.requests();
    assert.deepEqual(others, []);
    assert.ok(request !== undefined);
    assert.equal(operationOf(request), 'SendMessage');
    assert.equal(request.content_type, 'application/x-amz-json-1.0');
    assert.deepEqual(request.input, {
      QueueUrl: SEND.queue_url,
      MessageBody: SEND.body,
      MessageGroupId: TRIAL_ID,
      MessageDeduplicationId: TRIAL_ID,
    });
  });

  it('runs on a client pinned to us-east-1 with one attempt', async () => {
    const { sqs } = setup();
    assert.equal(await sqs.client.config.region(), COLLECTOR_SQS_CLIENT_OPTIONS.region);
    assert.equal(await sqs.client.config.maxAttempts(), 1);
  });

  it('maps an accepted send onto sent with what SQS returned', async () => {
    const { sqs, publish } = setup();
    sqs.script({ kind: 'accept' });
    assert.deepEqual(await publish(), {
      kind: 'sent',
      message_id: 'scripted-message-1',
      sequence_number: '10000000000000000001',
      md5_of_message_body: createHash('md5').update(SEND.body, 'utf8').digest('hex'),
    });
  });

  it('reads an accepted send whose output lacks a member as ambiguous', async () => {
    for (const member of ['MessageId', 'SequenceNumber']) {
      const { sqs, publish } = setup();
      sqs.script({ kind: 'accept_without', members: [member] });
      assert.deepEqual(await publish(), { kind: 'ambiguous', code: SEND_OUTPUT_INCOMPLETE }, member);
    }
  });

  it('reads a body MD5 mismatch as ambiguous: SQS accepted the request', async () => {
    const { sqs, publish } = setup();
    sqs.script({ kind: 'accept', md5: '0'.repeat(32) });
    const outcome = await publish();
    assert.equal(outcome.kind, 'ambiguous');
    assert.equal(sqs.requests().length, 1);
  });

  it('rejects a definitive 4xx client fault without retrying it', async () => {
    for (const type of ['QueueDoesNotExist', 'InvalidParameterValue', 'RequestThrottled']) {
      const { sqs, publish } = setup();
      sqs.script({ kind: 'error', type, status: 400 });
      assert.deepEqual(await publish(), { kind: 'rejected', code: type }, type);
      assert.equal(sqs.requests().length, 1, type);
    }
  });

  it('reads a 5xx and a network error as ambiguous, each after exactly one request', async () => {
    const server = setup();
    server.sqs.script({ kind: 'error', type: 'InternalError', status: 500 });
    assert.deepEqual(await server.publish(), { kind: 'ambiguous', code: 'InternalError' });
    assert.equal(server.sqs.requests().length, 1);
    const network = setup();
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    network.sqs.script({ kind: 'network_error', error: reset });
    assert.equal((await network.publish()).kind, 'ambiguous');
    assert.equal(network.sqs.requests().length, 1);
  });
});
