// Conformance of RecordingDynamoDbClient (design §12.2, RK-17): it is a real DynamoDBClient
// whose scripted replies follow the DynamoDB JSON 1.0 protocol, so the SDK deserializes them
// into its modeled exception classes exactly as it would a service reply
// (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html,
// API_TransactWriteItems Errors: CancellationReasons ordered like TransactItems).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  GetItemCommand,
  InternalServerError,
  PutItemCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';

import { RecordingDynamoDbClient } from '../../../support/durable-store/aws/recording-dynamodb-client.ts';

const KEY = { pk: { S: 'p' }, sk: { S: 's' } };

describe('RecordingDynamoDbClient contract', () => {
  it('is a real DynamoDBClient with one attempt in us-east-1', async () => {
    const recording = new RecordingDynamoDbClient();
    assert.ok(recording.client instanceof DynamoDBClient);
    assert.equal(await recording.client.config.maxAttempts(), 1);
    assert.equal(await recording.client.config.region(), 'us-east-1');
  });

  it('records the operation and the decoded JSON request of each call, in order', async () => {
    const recording = new RecordingDynamoDbClient();
    recording.respondWithSuccess({ Item: { ...KEY, n: { N: '1' } } });
    recording.respondWithSuccess();
    const got = await recording.client.send(new GetItemCommand({ TableName: 't', Key: KEY, ConsistentRead: true }));
    assert.deepEqual(got.Item, { ...KEY, n: { N: '1' } });
    await recording.client.send(new PutItemCommand({ TableName: 't', Item: KEY }));
    assert.deepEqual(recording.calls(), [
      {
        operation: 'GetItem',
        input: { TableName: 't', Key: KEY, ConsistentRead: true },
        hostname: 'dynamodb.us-east-1.amazonaws.com',
        attempt_header: 'attempt=1; max=1',
      },
      {
        operation: 'PutItem',
        input: { TableName: 't', Item: KEY },
        hostname: 'dynamodb.us-east-1.amazonaws.com',
        attempt_header: 'attempt=1; max=1',
      },
    ]);
    assert.equal(recording.pendingResponseCount(), 0);
  });

  it('scripted service errors become the SDK modeled exceptions with their members', async () => {
    const recording = new RecordingDynamoDbClient();
    recording.respondWithServiceError('TransactionCanceledException', {
      Message: 'Transaction cancelled',
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Item: KEY }],
    });
    recording.respondWithServiceError('ConditionalCheckFailedException', { message: 'failed', Item: KEY });
    recording.respondWithServiceError('InternalServerError', { message: 'internal' }, 500);
    const put = { TransactItems: [{ Put: { TableName: 't', Item: KEY } }] };
    await assert.rejects(recording.client.send(new TransactWriteItemsCommand(put)), (error: unknown) => {
      assert.ok(error instanceof TransactionCanceledException);
      assert.deepEqual(error.CancellationReasons, [{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Item: KEY }]);
      assert.equal(error.$metadata.httpStatusCode, 400);
      return true;
    });
    await assert.rejects(recording.client.send(new PutItemCommand({ TableName: 't', Item: KEY })), (error: unknown) => {
      assert.ok(error instanceof ConditionalCheckFailedException);
      assert.deepEqual(error.Item, KEY);
      return true;
    });
    await assert.rejects(recording.client.send(new PutItemCommand({ TableName: 't', Item: KEY })), (error: unknown) => {
      assert.ok(error instanceof InternalServerError);
      assert.equal(error.$fault, 'server');
      return true;
    });
    assert.equal(recording.calls().length, 3);
  });

  it('raw replies and network errors reach the SDK unchanged', async () => {
    const recording = new RecordingDynamoDbClient();
    recording.respondWith({ kind: 'raw', status: 200, body: 'not json' });
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    recording.respondWith({ kind: 'network_error', error: reset });
    await assert.rejects(recording.client.send(new PutItemCommand({ TableName: 't', Item: KEY })), {
      name: 'SyntaxError',
    });
    await assert.rejects(recording.client.send(new PutItemCommand({ TableName: 't', Item: KEY })), (error: unknown) => {
      assert.equal(error, reset);
      return true;
    });
  });

  it('fails loudly when a call has no scripted reply', async () => {
    const recording = new RecordingDynamoDbClient();
    await assert.rejects(recording.client.send(new GetItemCommand({ TableName: 't', Key: KEY })), {
      message: 'no scripted response for "DynamoDB_20120810.GetItem"; expected respondWith(...) before the call',
    });
    assert.equal(recording.calls()[0]?.operation, 'GetItem');
  });
});
