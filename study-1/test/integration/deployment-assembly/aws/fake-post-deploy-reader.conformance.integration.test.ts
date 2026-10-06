// FakePostDeployReader conformance (design §12.2): for one deployed account, the production reader
// over the real SDK clients and the scripted HTTP layer answers every port call exactly as the fake
// does: a described stack and a missing one, every resource page, every planned configuration read,
// missing resources, provisioned concurrency present and absent, and a scripted service failure.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPostDeployReader } from '../../../../src/deployment-assembly/aws/post-deploy-readers.ts';
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
import { FakePostDeployReader, pageToken } from '../../../support/deployment-assembly/fake-post-deploy-reader.ts';
import { ScriptedPostDeployEndpoint } from '../../../support/deployment-assembly/scripted-post-deploy-endpoint.ts';

type ReadCall = (reader: PostDeployReader) => Promise<unknown>;

interface Pair {
  readonly account: DeployedAccount;
  readonly fake: FakePostDeployReader;
  readonly endpoint: ScriptedPostDeployEndpoint;
  readonly real: PostDeployReader;
}

function pair(change: (account: DeployedAccount) => void = () => undefined): Pair {
  const account = deployedAccount(runTemplate(), RUN_STACK, stackIdOf(RUN_STACK), declaredTags());
  change(account);
  const endpoint = new ScriptedPostDeployEndpoint(account);
  return { account, fake: new FakePostDeployReader(account), endpoint, real: createPostDeployReader(endpoint.clients) };
}

async function assertSame(subject: Pair, call: ReadCall): Promise<void> {
  assert.deepEqual(await call(subject.fake), await call(subject.real));
}

function physicalIds(account: DeployedAccount): readonly string[] {
  return account.resources.map((resource) => String(resource['PhysicalResourceId']));
}

const PROVIDER = functionNameOf(FIXTURE_IDS.providerFunction);

describe('FakePostDeployReader conforms to the AWS post-deploy reader', () => {
  it('describes an existing stack by name and by id, and a missing one as undefined', async () => {
    const existing = pair();
    await assertSame(existing, (reader) => reader.describeStack(RUN_STACK));
    await assertSame(existing, (reader) => reader.describeStack(stackIdOf(RUN_STACK)));
    await assertSame(existing, (reader) => reader.describeStack('SucRua-run-00000000'));
    const missing = pair((account) => {
      account.stack = undefined;
    });
    await assertSame(missing, (reader) => reader.describeStack(RUN_STACK));
    await assertSame(missing, (reader) => reader.listStackResources(RUN_STACK));
  });

  it('answers the same pages and tokens', async () => {
    const paged = pair((account) => {
      account.page_size = 4;
    });
    const pages = Math.ceil(paged.account.resources.length / 4);
    await assertSame(paged, (reader) => reader.listStackResources(stackIdOf(RUN_STACK)));
    for (let page = 1; page < pages; page += 1) {
      await assertSame(paged, (reader) => reader.listStackResources(RUN_STACK, pageToken(page)));
    }
  });

  it('answers every configuration read of the account the same', async () => {
    const subject = pair();
    await assertSame(subject, (reader) => reader.readFunctionConfiguration(PROVIDER, DEPLOYED_PROVIDER_VERSION));
    for (const uuid of Object.keys(subject.account.mappings)) {
      await assertSame(subject, (reader) => reader.readEventSourceMapping(uuid));
    }
    for (const url of Object.keys(subject.account.queues)) {
      await assertSame(subject, (reader) => reader.readQueueAttributes(url));
    }
    for (const name of Object.keys(subject.account.tables)) {
      await assertSame(subject, (reader) => reader.readTable(name));
    }
    for (const arn of physicalIds(subject.account).filter((id) => id.startsWith('arn:aws:lambda:'))) {
      const [functionName = '', qualifier = ''] = arn.split(':').slice(6);
      await assertSame(subject, (reader) => reader.readProvisionedConcurrency(functionName, qualifier));
    }
  });

  it('answers a provisioned-concurrency configuration that exists the same', async () => {
    const subject = pair((account) => {
      account.concurrency[`${PROVIDER}:7`] = {
        RequestedProvisionedConcurrentExecutions: 1,
        AllocatedProvisionedConcurrentExecutions: 0,
        AvailableProvisionedConcurrentExecutions: 0,
        Status: 'IN_PROGRESS',
      };
    });
    await assertSame(subject, (reader) => reader.readProvisionedConcurrency(PROVIDER, '7'));
  });

  it('fails the same for resources that do not exist', async () => {
    const subject = pair();
    await assertSame(subject, (reader) => reader.readFunctionConfiguration(PROVIDER, '8'));
    await assertSame(subject, (reader) => reader.readEventSourceMapping('5a0e1c2d-0000-4000-8000-0000000000ff'));
    await assertSame(subject, (reader) =>
      reader.readQueueAttributes('https://sqs.us-east-1.amazonaws.com/123456789012/absent.fifo'),
    );
    await assertSame(subject, (reader) => reader.readTable('suc1-3f1c2a9e-absent'));
    await assertSame(subject, (reader) => reader.listStackResources('SucRua-run-00000000'));
  });

  it('fails the same with a scripted service error', async () => {
    const failures = [
      ['describeStack', 'cloudformation:DescribeStacks'],
      ['listStackResources', 'cloudformation:ListStackResources'],
      ['readFunctionConfiguration', 'lambda:GetFunctionConfiguration'],
      ['readEventSourceMapping', 'lambda:GetEventSourceMapping'],
      ['readProvisionedConcurrency', 'lambda:GetProvisionedConcurrencyConfig'],
      ['readQueueAttributes', 'sqs:GetQueueAttributes'],
      ['readTable', 'dynamodb:DescribeTable'],
    ] as const;
    for (const [method, operation] of failures) {
      const subject = pair();
      subject.fake.failWith(method, { code: 'ThrottlingException', detail: 'Rate exceeded' });
      subject.endpoint.fail(operation, { status: 400, code: 'ThrottlingException', message: 'Rate exceeded' });
      const queue = Object.keys(subject.account.queues)[0] ?? '';
      const reads: Record<typeof method, ReadCall> = {
        describeStack: (reader) => reader.describeStack(RUN_STACK),
        listStackResources: (reader) => reader.listStackResources(RUN_STACK),
        readFunctionConfiguration: (reader) => reader.readFunctionConfiguration(PROVIDER, '7'),
        readEventSourceMapping: (reader) => reader.readEventSourceMapping('5a0e1c2d-0000-4000-8000-000000000001'),
        readProvisionedConcurrency: (reader) => reader.readProvisionedConcurrency(PROVIDER, '7'),
        readQueueAttributes: (reader) => reader.readQueueAttributes(queue),
        readTable: (reader) => reader.readTable('suc1-3f1c2a9e-callerjournaltable'),
      };
      await assertSame(subject, reads[method]);
    }
  });

  it('records each call with its arguments', async () => {
    const subject = pair();
    await subject.fake.listStackResources(RUN_STACK, pageToken(1));
    await subject.fake.readProvisionedConcurrency(PROVIDER, '7');
    assert.deepEqual(subject.fake.calls(), [
      { method: 'listStackResources', args: [RUN_STACK, 'page-1'] },
      { method: 'readProvisionedConcurrency', args: [PROVIDER, '7'] },
    ]);
  });
});
