// Conformance of ScriptedSqsSendClient to SQS SendMessage on the wire
// (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html), as
// the real SDK reads it: an accepted send deserializes into MessageId, SequenceNumber and the MD5
// of the UTF-8 body (the SDK's own MD5 middleware accepts it); a wrong MD5 makes that middleware
// throw InvalidChecksumError; an error answer deserializes into the named service exception with
// its fault (`client` below 500, `server` from 500) and HTTP status.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { SendMessageCommand } from '@aws-sdk/client-sqs';

import { ScriptedSqsSendClient } from '../support/scripted-sqs-send-client.ts';
import { serviceException } from '../support/service-exception.ts';

const INPUT = {
  QueueUrl: 'https://sqs.us-east-1.amazonaws.com/012345678901/q.fifo',
  MessageBody: '{"trial":"é"}',
  MessageGroupId: 'g',
  MessageDeduplicationId: 'd',
};

describe('ScriptedSqsSendClient conformance', () => {
  it('answers an accepted send with an id, a sequence number and the UTF-8 body MD5', async () => {
    const sqs = new ScriptedSqsSendClient();
    sqs.script({ kind: 'accept' });
    const output = await sqs.client.send(new SendMessageCommand(INPUT));
    assert.equal(output.MessageId, 'scripted-message-1');
    assert.equal(output.SequenceNumber, '10000000000000000001');
    assert.equal(output.MD5OfMessageBody, createHash('md5').update(INPUT.MessageBody, 'utf8').digest('hex'));
    assert.equal(output.$metadata.httpStatusCode, 200);
  });

  it('lets the SDK MD5 middleware refuse a wrong body MD5', async () => {
    const sqs = new ScriptedSqsSendClient();
    sqs.script({ kind: 'accept', md5: 'f'.repeat(32) });
    await assert.rejects(sqs.client.send(new SendMessageCommand(INPUT)), { message: 'InvalidChecksumError' });
  });

  it('answers errors as service exceptions with their fault and status', async () => {
    const sqs = new ScriptedSqsSendClient();
    sqs.script({ kind: 'error', type: 'QueueDoesNotExist', status: 400 });
    sqs.script({ kind: 'error', type: 'InternalError', status: 500 });
    await assert.rejects(
      sqs.client.send(new SendMessageCommand(INPUT)),
      serviceException('QueueDoesNotExist', 'client', 400),
    );
    await assert.rejects(
      sqs.client.send(new SendMessageCommand(INPUT)),
      serviceException('InternalError', 'server', 500),
    );
  });

  it('records the decoded input and drops the named output members', async () => {
    const sqs = new ScriptedSqsSendClient();
    sqs.script({ kind: 'accept_without', members: ['MessageId'] });
    const output = await sqs.client.send(new SendMessageCommand(INPUT));
    assert.equal(output.MessageId, undefined);
    assert.equal(output.SequenceNumber, '10000000000000000001');
    assert.deepEqual(sqs.requests()[0]?.input, INPUT);
  });
});
