// Conformance of ScriptedCleanupEndpoint: under the real SDK clients it decodes every operation
// cleanup sends in each service's wire protocol, answers scripted bodies the SDK deserializes,
// answers scripted errors under the error names the SDK raises against AWS, repeats the last
// queued reply, and answers an unscripted operation with a failure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import {
  DeleteAliasCommand,
  GetDurableExecutionCommand,
  ListEventSourceMappingsCommand,
  ListTagsCommand,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import { GetQueueUrlCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';

import { sdkFailureOf } from '../../../../../src/cleanup/surface-readings.ts';
import {
  refuse,
  reply,
  ScriptedCleanupEndpoint,
  sqsMessage,
} from '../../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';

const DURABLE_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:f:3/durable-execution/run/0f0e';

async function failureName(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (thrown: unknown) {
    return sdkFailureOf(thrown).name;
  }
  return 'resolved';
}

describe('ScriptedCleanupEndpoint', () => {
  it('decodes Lambda REST routes into operations with their path labels and query', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:ListEventSourceMappings', reply({ EventSourceMappings: [] }));
    endpoint.answer('lambda:ListTags', reply({ Tags: { a: 'b' } }));
    endpoint.answer('lambda:StopDurableExecution', reply({}));
    endpoint.answer('lambda:GetDurableExecution', reply({ DurableExecutionArn: DURABLE_ARN, Status: 'RUNNING' }));
    endpoint.answer('lambda:DeleteAlias', reply({}));
    const { lambda } = endpoint.clients;
    await lambda.send(new ListEventSourceMappingsCommand({ FunctionName: 'f', Marker: 'm' }));
    const tags = await lambda.send(new ListTagsCommand({ Resource: 'arn:aws:lambda:us-east-1:1:function:f' }));
    await lambda.send(new StopDurableExecutionCommand({ DurableExecutionArn: DURABLE_ARN }));
    const execution = await lambda.send(new GetDurableExecutionCommand({ DurableExecutionArn: DURABLE_ARN }));
    await lambda.send(new DeleteAliasCommand({ FunctionName: 'f', Name: 'live' }));
    assert.deepEqual(tags.Tags, { a: 'b' });
    assert.equal(execution.Status, 'RUNNING');
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.region, call.input]),
      [
        ['ListEventSourceMappings', 'us-east-1', { FunctionName: 'f', Marker: 'm' }],
        ['ListTags', 'us-east-1', { Resource: 'arn:aws:lambda:us-east-1:1:function:f' }],
        ['StopDurableExecution', 'us-east-1', { DurableExecutionArn: DURABLE_ARN }],
        ['GetDurableExecution', 'us-east-1', { DurableExecutionArn: DURABLE_ARN }],
        ['DeleteAlias', 'us-east-1', { FunctionName: 'f', Name: 'live' }],
      ],
    );
  });

  it('decodes query and JSON protocols and answers their bodies', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer(
      'cloudformation:DescribeStacks',
      reply(
        '<Stacks><member><StackId>s</StackId><StackName>n</StackName><StackStatus>CREATE_COMPLETE</StackStatus><CreationTime>2026-10-05T11:00:00.000Z</CreationTime></member></Stacks>',
      ),
    );
    endpoint.answer(
      'iam:GetRole',
      reply(
        '<Role><RoleName>r</RoleName><Arn>arn:aws:iam::1:role/r</Arn><Path>/</Path><RoleId>AROA</RoleId><CreateDate>2026-10-05T11:00:00Z</CreateDate></Role>',
      ),
    );
    endpoint.answer('sqs:GetQueueUrl', reply({ QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q' }));
    endpoint.answer('sqs:ReceiveMessage', reply({ Messages: [sqsMessage('m', 'r')] }));
    endpoint.answer('dynamodb:DescribeTable', reply({ Table: { TableName: 't', TableArn: 'arn:t' } }));
    endpoint.answer('logs:DescribeLogGroups', reply({ logGroups: [{ logGroupName: 'g', creationTime: 0 }] }));
    endpoint.answer('tagging:GetResources', reply({ ResourceTagMappingList: [], PaginationToken: '' }));
    const { cloudformation, iam, sqs, dynamodb, logs, tagging } = endpoint.clients;
    const stacks = await cloudformation.send(new DescribeStacksCommand({ StackName: 's' }));
    const role = await iam.send(new GetRoleCommand({ RoleName: 'r' }));
    const url = await sqs.send(new GetQueueUrlCommand({ QueueName: 'q' }));
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: 'https://sqs.us-east-1.amazonaws.com/1/q' }));
    const table = await dynamodb.send(new DescribeTableCommand({ TableName: 't' }));
    const groups = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: '/suc/' }));
    const resources = await tagging.send(new GetResourcesCommand({ TagFilters: [{ Key: 'k', Values: ['v'] }] }));
    const [stack] = stacks.Stacks ?? [];
    assert.ok(stack?.CreationTime instanceof Date);
    assert.equal(stack.StackStatus, 'CREATE_COMPLETE');
    assert.equal(role.Role?.RoleName, 'r');
    assert.equal(url.QueueUrl, 'https://sqs.us-east-1.amazonaws.com/1/q');
    assert.equal(received.Messages?.[0]?.ReceiptHandle, 'r');
    assert.equal(table.Table?.TableArn, 'arn:t');
    assert.equal(groups.logGroups?.[0]?.logGroupName, 'g');
    assert.deepEqual(resources.ResourceTagMappingList, []);
    assert.deepEqual(endpoint.operations(), [
      'cloudformation:DescribeStacks',
      'iam:GetRole',
      'sqs:GetQueueUrl',
      'sqs:ReceiveMessage',
      'dynamodb:DescribeTable',
      'logs:DescribeLogGroups',
      'tagging:GetResources',
    ]);
    assert.equal(endpoint.calls('cloudformation:DescribeStacks')[0]?.input['StackName'], 's');
    assert.deepEqual(endpoint.calls('tagging:GetResources')[0]?.input, { TagFilters: [{ Key: 'k', Values: ['v'] }] });
    assert.deepEqual(
      endpoint.calls().map((call) => call.region),
      ['us-east-1', '', 'us-east-1', 'us-east-1', 'us-east-1', 'us-east-1', 'us-east-1'],
    );
  });

  it('answers scripted errors under the names the SDK raises against AWS', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:ListTags', refuse('ResourceNotFoundException', 'Function not found', 404));
    endpoint.answer('iam:GetRole', refuse('NoSuchEntity', 'role r', 404));
    endpoint.answer('sqs:GetQueueUrl', refuse('QueueDoesNotExist'));
    endpoint.answer('dynamodb:DescribeTable', refuse('ResourceNotFoundException'));
    endpoint.answer('logs:DescribeLogGroups', refuse('ResourceNotFoundException'));
    endpoint.answer('cloudformation:DescribeStacks', refuse('ValidationError', 'Stack with id s does not exist'));
    const { lambda, iam, sqs, dynamodb, logs, cloudformation } = endpoint.clients;
    assert.equal(
      await failureName(() => lambda.send(new ListTagsCommand({ Resource: 'arn' }))),
      'ResourceNotFoundException',
    );
    assert.equal(await failureName(() => iam.send(new GetRoleCommand({ RoleName: 'r' }))), 'NoSuchEntityException');
    assert.equal(await failureName(() => sqs.send(new GetQueueUrlCommand({ QueueName: 'q' }))), 'QueueDoesNotExist');
    assert.equal(
      await failureName(() => dynamodb.send(new DescribeTableCommand({ TableName: 't' }))),
      'ResourceNotFoundException',
    );
    assert.equal(await failureName(() => logs.send(new DescribeLogGroupsCommand({}))), 'ResourceNotFoundException');
    assert.equal(
      await failureName(() => cloudformation.send(new DescribeStacksCommand({ StackName: 's' }))),
      'ValidationError',
    );
  });

  it('repeats the last queued reply, follows a responder, and fails an unscripted operation', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('sqs:GetQueueUrl', reply({ QueueUrl: 'https://a' }), reply({ QueueUrl: 'https://b' }));
    const { sqs, dynamodb } = endpoint.clients;
    const urls: (string | undefined)[] = [];
    for (let index = 0; index < 3; index += 1) {
      urls.push((await sqs.send(new GetQueueUrlCommand({ QueueName: 'q' }))).QueueUrl);
    }
    assert.deepEqual(urls, ['https://a', 'https://b', 'https://b']);
    endpoint.respond('dynamodb:DescribeTable', (call) =>
      reply({ Table: { TableName: String(call.input['TableName']) } }),
    );
    assert.equal((await dynamodb.send(new DescribeTableCommand({ TableName: 'x' }))).Table?.TableName, 'x');
    assert.notEqual(
      await failureName(() => sqs.send(new ReceiveMessageCommand({ QueueUrl: 'https://a' }))),
      'resolved',
    );
  });
});
