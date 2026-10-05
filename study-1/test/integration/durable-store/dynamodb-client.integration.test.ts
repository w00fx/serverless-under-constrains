// The production DynamoDB client factory (design §9.4): `maxAttempts: 1` wins over
// AWS_MAX_ATTEMPTS and over caller settings, and the region is fixed. Uses the real SDK config
// resolution; nothing is sent.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  createStoreDynamoDbClient,
  STORE_DYNAMODB_CLIENT_OPTIONS,
} from '../../../src/durable-store/aws/dynamodb-client.ts';
import type { StoreClientSettings } from '../../../src/durable-store/aws/dynamodb-client.ts';

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
});
