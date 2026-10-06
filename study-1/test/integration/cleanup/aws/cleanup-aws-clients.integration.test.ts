// The clients of cleanup (design §9.4): every one is built for `us-east-1` with a single attempt,
// whatever a caller passes, so a throttled or failed request is sent exactly once and never to
// another Region.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import { GetFunctionCommand } from '@aws-sdk/client-lambda';
import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';

import type { CleanupClientSettings } from '../../../../src/cleanup/aws/cleanup-aws-clients.ts';
import { CLEANUP_CLIENT_OPTIONS } from '../../../../src/cleanup/aws/cleanup-aws-clients.ts';
import { settleCleanupCall } from '../../../../src/cleanup/sdk-call-outcomes.ts';
import { refuse, ScriptedCleanupEndpoint } from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';

describe('createCleanupAwsClients', () => {
  it('builds every client for us-east-1 with one attempt, even when a caller smuggles other values', async () => {
    const smuggled = { region: 'eu-west-1', maxAttempts: 5, retryMode: 'adaptive' } as unknown as CleanupClientSettings;
    const endpoint = new ScriptedCleanupEndpoint(smuggled);
    const { lambda, sqs, cloudformation, dynamodb, logs, iam, tagging } = endpoint.clients;
    for (const client of [lambda, sqs, cloudformation, dynamodb, logs, iam, tagging]) {
      assert.equal(await client.config.region(), CLEANUP_CLIENT_OPTIONS.region);
      assert.equal(await client.config.maxAttempts(), 1);
    }
  });

  it('sends a throttled request of every service exactly once', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    for (const operation of [
      'lambda:GetFunction',
      'sqs:GetQueueUrl',
      'cloudformation:DescribeStacks',
      'dynamodb:DescribeTable',
      'logs:DescribeLogGroups',
      'iam:GetRole',
      'tagging:GetResources',
    ]) {
      endpoint.answer(operation, refuse('ThrottlingException', 'Rate exceeded', 400));
    }
    const { lambda, sqs, cloudformation, dynamodb, logs, iam, tagging } = endpoint.clients;
    const calls = [
      settleCleanupCall(() => lambda.send(new GetFunctionCommand({ FunctionName: 'f' }))),
      settleCleanupCall(() => sqs.send(new GetQueueUrlCommand({ QueueName: 'q' }))),
      settleCleanupCall(() => cloudformation.send(new DescribeStacksCommand({ StackName: 's' }))),
      settleCleanupCall(() => dynamodb.send(new DescribeTableCommand({ TableName: 't' }))),
      settleCleanupCall(() => logs.send(new DescribeLogGroupsCommand({}))),
      settleCleanupCall(() => iam.send(new GetRoleCommand({ RoleName: 'r' }))),
      settleCleanupCall(() => tagging.send(new GetResourcesCommand({}))),
    ];
    const settled = await Promise.all(calls);
    assert.ok(settled.every((call) => !call.ok && call.error.name === 'ThrottlingException'));
    assert.equal(endpoint.calls().length, 7);
  });
});
