// The AWS bindings of admission's read ports (design §10.1 A6-A8, §9.1). Over the real SDK
// clients `createAdmissionClients` builds and a scripted HTTP layer, each port sends exactly one
// read per call (DescribeTable and DescribeTimeToLive for the table) to `us-east-1`, maps the
// answer through the pure readers, keeps a service error's name and message as the failure, reads
// a missing `CDKToolkit` stack as an answer, and never retries. Pinned client settings cannot be
// overridden, even through a cast.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createAccountSettingsReader,
  createAdmissionClients,
  createBootstrapStackReader,
  createCallerIdentityReader,
  createCoordinationTableReader,
} from '../../../src/admission/aws/admission-aws-readers.ts';
import type { AdmissionClientSettings } from '../../../src/admission/aws/admission-aws-readers.ts';
import { ACCOUNT_ID, CALLER_ARN, CONFIGURED_TABLE, TABLE_ARN } from '../../support/admission/admission-fixtures.ts';
import { ScriptedAdmissionEndpoint } from '../../support/admission/scripted-admission-endpoint.ts';

const DESCRIBED_TABLE = {
  TableArn: TABLE_ARN,
  TableName: 'suc-study-1-coordination',
  TableStatus: 'ACTIVE',
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
  ],
  DeletionProtectionEnabled: true,
};

describe('admission AWS readers', () => {
  it('reads the caller identity and the configured Region', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.answerCallerIdentity(ACCOUNT_ID, CALLER_ARN);
    assert.deepEqual(await createCallerIdentityReader(endpoint.clients.sts).readCallerIdentity(), {
      ok: true,
      value: { account: ACCOUNT_ID, arn: CALLER_ARN, region: 'us-east-1' },
    });
    assert.deepEqual(endpoint.calls(), [{ service: 'sts', operation: 'GetCallerIdentity', region: 'us-east-1' }]);
  });

  it('keeps an STS error name and message, with one attempt only', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.fail('sts:GetCallerIdentity', { status: 503, code: 'ServiceUnavailable', message: 'try later' });
    assert.deepEqual(await createCallerIdentityReader(endpoint.clients.sts).readCallerIdentity(), {
      ok: false,
      error: { code: 'ServiceUnavailable', detail: 'try later' },
    });
    assert.equal(endpoint.calls().length, 1, 'a retryable error is not retried');
  });

  it('reads the unreserved concurrency, and refuses a malformed answer', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.answerAccountSettings({ UnreservedConcurrentExecutions: 990, ConcurrentExecutions: 1000 });
    const reader = createAccountSettingsReader(endpoint.clients.lambda);
    assert.deepEqual(await reader.readUnreservedConcurrency(), { ok: true, value: 990 });
    endpoint.answerAccountSettings({ ConcurrentExecutions: 1000 });
    const malformed = await reader.readUnreservedConcurrency();
    assert.ok(!malformed.ok);
    assert.equal(malformed.error.code, 'GetAccountSettingsOutputMalformed');
    endpoint.fail('lambda:GetAccountSettings', {
      status: 429,
      code: 'TooManyRequestsException',
      message: 'Rate exceeded',
    });
    assert.deepEqual(await reader.readUnreservedConcurrency(), {
      ok: false,
      error: { code: 'TooManyRequestsException', detail: 'Rate exceeded' },
    });
    assert.deepEqual(
      endpoint.calls().map((call) => call.operation),
      ['GetAccountSettings', 'GetAccountSettings', 'GetAccountSettings'],
    );
  });

  it('reads the bootstrap stack status; a missing stack is undefined, another failure is not', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    const reader = createBootstrapStackReader(endpoint.clients.cloudformation);
    endpoint.answerBootstrapStack('UPDATE_ROLLBACK_COMPLETE');
    assert.deepEqual(await reader.readBootstrapStackStatus(), { ok: true, value: 'UPDATE_ROLLBACK_COMPLETE' });
    endpoint.answerBootstrapStack(undefined);
    assert.deepEqual(await reader.readBootstrapStackStatus(), { ok: true, value: undefined });
    endpoint.fail('cloudformation:DescribeStacks', { status: 403, code: 'AccessDenied', message: 'not allowed' });
    assert.deepEqual(await reader.readBootstrapStackStatus(), {
      ok: false,
      error: { code: 'AccessDenied', detail: 'not allowed' },
    });
  });

  it('describes the coordination table and its TTL', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.answerCoordinationTable(DESCRIBED_TABLE, { TimeToLiveStatus: 'DISABLED' });
    assert.deepEqual(await createCoordinationTableReader(endpoint.clients.dynamodb).readCoordinationTable(TABLE_ARN), {
      ok: true,
      value: CONFIGURED_TABLE,
    });
    assert.deepEqual(
      endpoint.calls().map((call) => `${call.operation}@${call.region}`),
      ['DescribeTable@us-east-1', 'DescribeTimeToLive@us-east-1'],
    );
  });

  it('stops after a failed DescribeTable and keeps a DescribeTimeToLive failure', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    const reader = createCoordinationTableReader(endpoint.clients.dynamodb);
    endpoint.fail('dynamodb:DescribeTable', {
      status: 400,
      code: 'ResourceNotFoundException',
      message: 'Requested resource not found',
    });
    assert.deepEqual(await reader.readCoordinationTable(TABLE_ARN), {
      ok: false,
      error: { code: 'ResourceNotFoundException', detail: 'Requested resource not found' },
    });
    assert.deepEqual(
      endpoint.calls().map((call) => call.operation),
      ['DescribeTable'],
    );
    endpoint.answerCoordinationTable(DESCRIBED_TABLE, { TimeToLiveStatus: 'DISABLED' });
    endpoint.fail('dynamodb:DescribeTimeToLive', { status: 400, code: 'AccessDeniedException', message: 'denied' });
    assert.deepEqual(await reader.readCoordinationTable(TABLE_ARN), {
      ok: false,
      error: { code: 'AccessDeniedException', detail: 'denied' },
    });
  });

  it('pins the Region and a single attempt even when a caller casts them in', async () => {
    const clients = createAdmissionClients({
      region: 'eu-west-1',
      maxAttempts: 5,
      credentials: { accessKeyId: 'AKIDPINNED', secretAccessKey: 'pinned-not-a-secret' },
    } as unknown as AdmissionClientSettings);
    for (const client of [clients.sts, clients.lambda, clients.cloudformation, clients.dynamodb]) {
      assert.equal(await client.config.region(), 'us-east-1');
      assert.equal(await client.config.maxAttempts(), 1);
    }
  });
});
