// The AWS binding of the post-deploy reads (design §9.8 D4; BR-RUA-040, BR-RUA-053; addendum
// §2.4). Over the real SDK clients `createPostDeployClients` builds and a scripted HTTP layer, each
// port method sends exactly one read to `us-east-1` with the identifying parameters, maps the answer
// through the total mappers, keeps a service error's name and message as the failure, never
// retries, and reads a missing stack and a missing provisioned-concurrency configuration as answers.
// Pinned client settings cannot be overridden, even through a cast.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createPostDeployClients,
  createPostDeployReader,
  POST_DEPLOY_CLIENT_OPTIONS,
} from '../../../../src/deployment-assembly/aws/post-deploy-readers.ts';
import type { PostDeployClientSettings } from '../../../../src/deployment-assembly/aws/post-deploy-readers.ts';
import type { PostDeployReader } from '../../../../src/deployment-assembly/post-deploy-reading.ts';
import { declaredTags, RUN_STACK } from '../../../support/deployment-assembly/deployment-fixtures.ts';
import {
  deployedAccount,
  DEPLOYED_PROVIDER_VERSION,
  functionNameOf,
  stackIdOf,
} from '../../../support/deployment-assembly/deployed-account.ts';
import type { DeployedAccount } from '../../../support/deployment-assembly/deployed-account.ts';
import { FIXTURE_IDS, runTemplate } from '../../../support/deployment-assembly/execution-template-fixture.ts';
import { ScriptedPostDeployEndpoint } from '../../../support/deployment-assembly/scripted-post-deploy-endpoint.ts';

const PROVIDER = functionNameOf(FIXTURE_IDS.providerFunction);

interface ReaderRig {
  readonly account: DeployedAccount;
  readonly endpoint: ScriptedPostDeployEndpoint;
  readonly reader: PostDeployReader;
}

function rig(): ReaderRig {
  const account = deployedAccount(runTemplate(), RUN_STACK, stackIdOf(RUN_STACK), declaredTags());
  const endpoint = new ScriptedPostDeployEndpoint(account);
  return { account, endpoint, reader: createPostDeployReader(endpoint.clients) };
}

function physicalIdOf(account: DeployedAccount, logicalId: string): string {
  const summary = account.resources.find((resource) => resource['LogicalResourceId'] === logicalId);
  return String(summary?.['PhysicalResourceId']);
}

describe('post-deploy AWS readers', () => {
  it('describes the stack by name with its id, status and tags', async () => {
    const { endpoint, reader } = rig();
    assert.deepEqual(await reader.describeStack(RUN_STACK), {
      ok: true,
      value: {
        stack_id: stackIdOf(RUN_STACK),
        stack_status: 'CREATE_COMPLETE',
        tags: declaredTags(),
      },
    });
    assert.deepEqual(endpoint.calls(), [
      { service: 'cloudformation', operation: 'DescribeStacks', region: 'us-east-1', params: { StackName: RUN_STACK } },
    ]);
  });

  it('reads a stack that does not exist as undefined, and keeps any other error', async () => {
    const { account, endpoint, reader } = rig();
    account.stack = undefined;
    assert.deepEqual(await reader.describeStack(RUN_STACK), { ok: true, value: undefined });
    endpoint.fail('cloudformation:DescribeStacks', { status: 400, code: 'Throttling', message: 'Rate exceeded' });
    assert.deepEqual(await reader.describeStack(RUN_STACK), {
      ok: false,
      error: { code: 'Throttling', detail: 'Rate exceeded' },
    });
    assert.equal(endpoint.calls().length, 2, 'a throttled read is not retried');
  });

  it('lists one page per call and passes the next token on', async () => {
    const { account, endpoint, reader } = rig();
    account.page_size = 10;
    const first = await reader.listStackResources(stackIdOf(RUN_STACK));
    assert.equal(first.ok && first.value.resources.length, 10);
    assert.equal(first.ok && first.value.next_token, 'page-1');
    const second = await reader.listStackResources(stackIdOf(RUN_STACK), 'page-1');
    assert.equal(second.ok && second.value.resources.length, account.resources.length - 10);
    assert.equal(second.ok && second.value.next_token, undefined);
    assert.deepEqual(
      endpoint.calls().map((call) => call.params),
      [{ StackName: stackIdOf(RUN_STACK) }, { StackName: stackIdOf(RUN_STACK), NextToken: 'page-1' }],
    );
    assert.deepEqual(first.ok && first.value.resources[0], {
      logical_id: String(account.resources[0]?.['LogicalResourceId']),
      resource_type: String(account.resources[0]?.['ResourceType']),
      physical_id: String(account.resources[0]?.['PhysicalResourceId']),
      resource_status: 'CREATE_COMPLETE',
    });
  });

  it('reads the provider version configuration with the version as qualifier', async () => {
    const { endpoint, reader } = rig();
    const read = await reader.readFunctionConfiguration(PROVIDER, DEPLOYED_PROVIDER_VERSION);
    assert.deepEqual(read, {
      ok: true,
      value: [
        { attribute_path: 'Runtime', value: 'nodejs24.x' },
        { attribute_path: 'Architectures', value: ['x86_64'] },
        { attribute_path: 'MemorySize', value: 512 },
        { attribute_path: 'Timeout', value: 30 },
        { attribute_path: 'Version', value: '7' },
        { attribute_path: 'EnvironmentKeys', value: ['SUC_EXECUTION_ID', 'SUC_TABLE_LEDGER'] },
      ],
    });
    assert.deepEqual(endpoint.calls(), [
      {
        service: 'lambda',
        operation: 'GetFunctionConfiguration',
        region: 'us-east-1',
        params: { FunctionName: PROVIDER, Qualifier: '7' },
      },
    ]);
  });

  it('reads an event source mapping by UUID with its state and settings', async () => {
    const { account, endpoint, reader } = rig();
    const uuid = physicalIdOf(account, FIXTURE_IDS.controllerMapping);
    const read = await reader.readEventSourceMapping(uuid);
    assert.ok(read.ok);
    const byPath = new Map(read.value.map((reading) => [reading.attribute_path, reading.value]));
    assert.equal(byPath.get('State'), 'Enabled');
    assert.equal(byPath.get('StartingPosition'), 'TRIM_HORIZON');
    assert.deepEqual(byPath.get('FilterCriteria'), { Filters: [{ Pattern: '{"eventName":["INSERT"]}' }] });
    assert.equal(byPath.get('ScalingConfig'), null);
    assert.deepEqual(endpoint.calls()[0]?.params, { UUID: uuid });
  });

  it('reads a missing provisioned-concurrency configuration as absent, and a present one as its value', async () => {
    const { account, endpoint, reader } = rig();
    assert.deepEqual(await reader.readProvisionedConcurrency(PROVIDER, '7'), {
      ok: true,
      value: [{ attribute_path: 'ProvisionedConcurrencyConfig', value: null }],
    });
    account.concurrency[`${PROVIDER}:7`] = {
      RequestedProvisionedConcurrentExecutions: 2,
      AllocatedProvisionedConcurrentExecutions: 2,
      AvailableProvisionedConcurrentExecutions: 2,
      Status: 'READY',
    };
    assert.deepEqual(await reader.readProvisionedConcurrency(PROVIDER, '7'), {
      ok: true,
      value: [
        {
          attribute_path: 'ProvisionedConcurrencyConfig',
          value: {
            RequestedProvisionedConcurrentExecutions: 2,
            AllocatedProvisionedConcurrentExecutions: 2,
            AvailableProvisionedConcurrentExecutions: 2,
            Status: 'READY',
          },
        },
      ],
    });
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.params]),
      [
        ['GetProvisionedConcurrencyConfig', { FunctionName: PROVIDER, Qualifier: '7' }],
        ['GetProvisionedConcurrencyConfig', { FunctionName: PROVIDER, Qualifier: '7' }],
      ],
    );
  });

  it('reads the queue attributes as strings, asking for all of them', async () => {
    const { account, endpoint, reader } = rig();
    const url = physicalIdOf(account, FIXTURE_IDS.conventionalSource);
    const read = await reader.readQueueAttributes(url);
    assert.deepEqual(read, {
      ok: true,
      value: [
        { attribute_path: 'FifoQueue', value: 'true' },
        { attribute_path: 'ContentBasedDeduplication', value: 'false' },
        { attribute_path: 'VisibilityTimeout', value: '60' },
        {
          attribute_path: 'RedrivePolicy',
          value:
            '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:suc1-3f1c2a9e-dlq.fifo","maxReceiveCount":2}',
        },
      ],
    });
    assert.deepEqual(endpoint.calls()[0], {
      service: 'sqs',
      operation: 'GetQueueAttributes',
      region: 'us-east-1',
      params: { QueueUrl: url },
    });
  });

  it('reads the table stream specification and billing mode', async () => {
    const { account, endpoint, reader } = rig();
    const name = physicalIdOf(account, FIXTURE_IDS.callerJournalTable);
    assert.deepEqual(await reader.readTable(name), {
      ok: true,
      value: [
        { attribute_path: 'StreamSpecification', value: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' } },
        { attribute_path: 'BillingModeSummary.BillingMode', value: 'PAY_PER_REQUEST' },
      ],
    });
    assert.deepEqual(endpoint.calls()[0]?.params, { TableName: name });
    assert.equal(endpoint.calls()[0]?.operation, 'DescribeTable');
  });

  it('keeps each service error name and message, once each', async () => {
    const { account, endpoint, reader } = rig();
    endpoint.fail('lambda:GetFunctionConfiguration', {
      status: 429,
      code: 'TooManyRequestsException',
      message: 'Rate exceeded',
    });
    endpoint.fail('lambda:GetEventSourceMapping', { status: 404, code: 'ResourceNotFoundException', message: 'gone' });
    endpoint.fail('lambda:GetProvisionedConcurrencyConfig', { status: 500, code: 'ServiceException', message: 'boom' });
    endpoint.fail('sqs:GetQueueAttributes', { status: 400, code: 'QueueDoesNotExist', message: 'no queue' });
    endpoint.fail('dynamodb:DescribeTable', { status: 400, code: 'ResourceNotFoundException', message: 'no table' });
    endpoint.fail('cloudformation:ListStackResources', { status: 400, code: 'ValidationError', message: 'no stack' });
    const answers = [
      await reader.readFunctionConfiguration(PROVIDER, '7'),
      await reader.readEventSourceMapping('5a0e1c2d-0000-4000-8000-000000000001'),
      await reader.readProvisionedConcurrency(PROVIDER, '7'),
      await reader.readQueueAttributes(physicalIdOf(account, FIXTURE_IDS.conventionalSource)),
      await reader.readTable('suc1-3f1c2a9e-callerjournaltable'),
      await reader.listStackResources(RUN_STACK),
    ];
    assert.deepEqual(answers, [
      { ok: false, error: { code: 'TooManyRequestsException', detail: 'Rate exceeded' } },
      { ok: false, error: { code: 'ResourceNotFoundException', detail: 'gone' } },
      { ok: false, error: { code: 'ServiceException', detail: 'boom' } },
      { ok: false, error: { code: 'QueueDoesNotExist', detail: 'no queue' } },
      { ok: false, error: { code: 'ResourceNotFoundException', detail: 'no table' } },
      { ok: false, error: { code: 'ValidationError', detail: 'no stack' } },
    ]);
    assert.equal(endpoint.calls().length, answers.length, 'no failed read is retried');
    assert.ok(endpoint.calls().every((call) => call.region === 'us-east-1'));
  });

  it('refuses a malformed answer instead of recording it', async () => {
    const { account, reader } = rig();
    const functionAnswer = account.functions[`${PROVIDER}:7`];
    assert.ok(functionAnswer !== undefined);
    functionAnswer['Environment'] = { Variables: 'not-an-object' };
    assert.deepEqual(await reader.readFunctionConfiguration(PROVIDER, '7'), {
      ok: false,
      error: {
        code: 'GetFunctionConfigurationOutputMalformed',
        detail: 'Environment.Variables "not-an-object"; expected an object or none',
      },
    });
  });

  it('pins the Region and the single attempt, even against a cast', async () => {
    const smuggled = { region: 'eu-west-1', maxAttempts: 5 } as unknown as PostDeployClientSettings;
    const clients = createPostDeployClients(smuggled);
    for (const client of [clients.cloudformation, clients.lambda, clients.sqs, clients.dynamodb]) {
      assert.equal(await client.config.region(), POST_DEPLOY_CLIENT_OPTIONS.region);
      assert.equal(await client.config.maxAttempts(), 1);
    }
    const account = deployedAccount(runTemplate(), RUN_STACK, stackIdOf(RUN_STACK), declaredTags());
    const endpoint = new ScriptedPostDeployEndpoint(account, { region: 'eu-west-1' });
    await createPostDeployReader(endpoint.clients).describeStack(RUN_STACK);
    assert.equal(endpoint.calls()[0]?.region, 'us-east-1');
  });
});
