// The production DynamoDB client factory (design §9.4): `maxAttempts: 1` wins over
// AWS_MAX_ATTEMPTS and over caller settings, and the region is fixed. Uses the real SDK config
// resolution; requests go only to the recording HTTP handler, never to the network.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  createStoreDynamoDbClient,
  STORE_DYNAMODB_CLIENT_OPTIONS,
} from '../../../src/durable-store/aws/dynamodb-client.ts';
import type { StoreClientSettings } from '../../../src/durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../../../src/durable-store/aws/dynamodb-item-store.ts';
import { EagerRetryStrategy } from '../../support/durable-store/aws/eager-retry-strategy.ts';
import { RecordingDynamoDbClient } from '../../support/durable-store/aws/recording-dynamodb-client.ts';

describe('createStoreDynamoDbClient', () => {
  const saved = process.env['AWS_MAX_ATTEMPTS'];
  before(() => {
    process.env['AWS_MAX_ATTEMPTS'] = '5';
  });
  after(() => {
    if (saved === undefined) {
      delete process.env['AWS_MAX_ATTEMPTS'];
      return;
    }
    process.env['AWS_MAX_ATTEMPTS'] = saved;
  });

  it('declares one attempt in us-east-1', () => {
    assert.deepEqual(STORE_DYNAMODB_CLIENT_OPTIONS, { region: 'us-east-1', maxAttempts: 1 });
  });

  it('resolves maxAttempts 1 even when AWS_MAX_ATTEMPTS=5', async () => {
    const client = createStoreDynamoDbClient();
    assert.equal(await client.config.maxAttempts(), 1);
    assert.equal(await client.config.region(), 'us-east-1');
  });

  it('ignores retry and region settings smuggled past the type', async () => {
    const smuggled = { maxAttempts: 9, region: 'eu-west-1' } as unknown as StoreClientSettings;
    const client = createStoreDynamoDbClient(smuggled);
    assert.equal(await client.config.maxAttempts(), 1);
    assert.equal(await client.config.region(), 'us-east-1');
  });

  it('sends exactly one request even when a retry strategy is smuggled past the type', async () => {
    const smuggled = {
      retryStrategy: new EagerRetryStrategy(4),
      retryMode: 'adaptive',
    } as unknown as StoreClientSettings;
    const recorder = new RecordingDynamoDbClient(smuggled);
    for (let reply = 0; reply < 4; reply += 1) {
      recorder.respondWithServiceError('InternalServerError', {}, 500);
    }
    const store = createDynamoDbItemStore({ ledger: 'ledger-table' }, recorder.client);
    const outcome = await store.write({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's' } });
    assert.deepEqual(outcome, { kind: 'ambiguous', code: 'InternalServerError' });
    assert.equal(recorder.calls().length, 1);
    assert.equal(recorder.pendingResponseCount(), 3);
  });

  it('keeps every other caller setting', async () => {
    const recorder = new RecordingDynamoDbClient({ endpoint: 'https://dynamodb.example.test' });
    recorder.respondWithSuccess({ Item: { pk: { S: 'p' }, sk: { S: 's' } } });
    const store = createDynamoDbItemStore({ control: 'control-table' }, recorder.client);
    assert.deepEqual(await store.getConsistent('control', { pk: 'p', sk: 's' }), {
      ok: true,
      value: { pk: 'p', sk: 's' },
    });
    assert.equal(recorder.calls()[0]?.hostname, 'dynamodb.example.test');
  });
});
