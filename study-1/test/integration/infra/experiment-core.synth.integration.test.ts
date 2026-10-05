// Synthesis of ExperimentCore (design §9.2-§9.6, F-2, addendum §2; AC-RUA-053 feed): the five
// run-owned tables, the provider and its published version, the controller and its filtered
// stream mapping, and exactly the §9.6 IAM matrix. Real CDK synthesis with real local esbuild
// bundling of the production handlers; Docker is forbidden (CDK_DOCKER points at a sentinel that
// fails), and nothing touches AWS.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  CALLER_TIMEOUT_INSERT_FILTER,
  CONTROLLER_STREAM_SETTINGS,
  CONTROLLER_TIMEOUT,
  EXPERIMENT_CORE_ID,
  ExperimentCore,
  PROVIDER_TIMEOUT,
} from '../../../infra/constructs/experiment-core.ts';
import { parseExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { RUN_OWNED_TABLE_ROLES, stackName, tableName } from '../../../infra/ownership/resource-naming.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { CONTROLLER_STREAM_FILTER } from '../../../src/treatment-controller/stream-record.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCKER_SENTINEL = join(STUDY_ROOT, 'tools/docker-forbidden.sh');
const EXECUTION_ID = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f' as Uuid4;

const context: ExecutionSynthContext = parseExecutionSynthContext({
  execution_kind: 'RUN',
  execution_id: EXECUTION_ID,
  account: '123456789012',
  region: 'us-east-1',
  admitted_at: '2026-10-05T12:00:00.000Z',
  total_target_ms: 7_200_000,
});

interface SynthResource {
  readonly Type: string;
  readonly Properties: Readonly<Record<string, unknown>>;
}

interface PolicyStatementJson {
  readonly Action: string | readonly string[];
  readonly Resource: unknown;
}

let outdir = '';
let template: Template;
let core: ExperimentCore;
let stack: Stack;
let bundleFiles: readonly string[] = [];

before(() => {
  process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
  outdir = mkdtempSync(join(tmpdir(), 'rua-core-synth-'));
  const app = new App({ outdir });
  stack = new Stack(app, stackName(context.execution_kind, context.execution_id), {
    env: { account: context.account, region: context.region },
  });
  core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
  template = Template.fromStack(stack);
  const assembly = app.synth();
  bundleFiles = readdirSync(assembly.directory)
    .filter((name) => name.startsWith('asset.'))
    .map((name) => join(assembly.directory, name, 'index.mjs'));
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

function resourcesOf(type: string): Readonly<Record<string, SynthResource>> {
  return template.findResources(type) as Readonly<Record<string, SynthResource>>;
}

function logicalId(construct: { readonly node: { readonly defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as never);
}

// The role's statements, without the log-group write every ObservableFunction carries (tested
// with ObservableFunction), as `action -> resource` pairs.
function grantsOf(roleLogicalId: string): readonly string[] {
  const policies = Object.values(resourcesOf('AWS::IAM::Policy')).filter(
    (policy) => JSON.stringify(policy.Properties['Roles']) === JSON.stringify([{ Ref: roleLogicalId }]),
  );
  const statements = policies.flatMap(
    (policy) =>
      (policy.Properties['PolicyDocument'] as { readonly Statement: readonly PolicyStatementJson[] }).Statement,
  );
  return statements
    .flatMap((statement) =>
      [statement.Action].flat().map((action) => `${action} -> ${JSON.stringify(statement.Resource)}`),
    )
    .filter((grant) => !grant.startsWith('logs:'))
    .toSorted();
}

function arnOf(id: string, attribute = 'Arn'): string {
  return JSON.stringify({ 'Fn::GetAtt': [id, attribute] });
}

describe('ExperimentCore synthesis', () => {
  it('creates the five run-owned tables: pk/sk strings, on demand, destroyed with the stack, no GSI or TTL', () => {
    const tables = Object.values(
      template.findResources('AWS::DynamoDB::Table') as Readonly<
        Record<string, SynthResource & { readonly DeletionPolicy?: string }>
      >,
    );
    assert.deepEqual(
      tables.map((table) => table.Properties['TableName']).toSorted(),
      RUN_OWNED_TABLE_ROLES.map((role) => tableName(EXECUTION_ID, role)).toSorted(),
    );
    for (const table of tables) {
      assert.deepEqual(table.Properties['KeySchema'], [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ]);
      assert.deepEqual(table.Properties['AttributeDefinitions'], [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ]);
      assert.equal(table.Properties['BillingMode'], 'PAY_PER_REQUEST');
      assert.equal(table.DeletionPolicy, 'Delete');
      assert.equal('GlobalSecondaryIndexes' in table.Properties, false);
      assert.equal('TimeToLiveSpecification' in table.Properties, false);
    }
  });

  it('streams only the caller journal, with NEW_IMAGE', () => {
    const streamed = Object.values(resourcesOf('AWS::DynamoDB::Table')).filter(
      (table) => 'StreamSpecification' in table.Properties,
    );
    assert.deepEqual(
      streamed.map((table) => [table.Properties['TableName'], table.Properties['StreamSpecification']]),
      [[tableName(EXECUTION_ID, 'caller-journal'), { StreamViewType: 'NEW_IMAGE' }]],
    );
  });

  it('deploys the provider and the controller with their timeouts and environments', () => {
    assert.equal(PROVIDER_TIMEOUT.toSeconds(), 30);
    assert.equal(CONTROLLER_TIMEOUT.toSeconds(), 30);
    const identity = { SUC_EXECUTION_KIND: 'RUN', SUC_EXECUTION_ID: EXECUTION_ID };
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 30,
      Environment: {
        Variables: {
          ...identity,
          SUC_TABLE_LEDGER: tableName(EXECUTION_ID, 'ledger'),
          SUC_TABLE_EXPERIMENT_JOURNAL: tableName(EXECUTION_ID, 'experiment-journal'),
          SUC_TABLE_CONTROL: tableName(EXECUTION_ID, 'control'),
        },
      },
    });
    const controller = resourcesOf('AWS::Lambda::Function')[logicalId(core.controller.function)];
    assert.deepEqual(controller?.Properties['Environment'], {
      Variables: {
        ...identity,
        SUC_TABLE_EXPERIMENT_JOURNAL: tableName(EXECUTION_ID, 'experiment-journal'),
        SUC_TABLE_CONTROL: tableName(EXECUTION_ID, 'control'),
      },
    });
    assert.equal(controller.Properties['Timeout'], 30);
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  it('publishes exactly one provider version and no provisioned concurrency anywhere (addendum §2)', () => {
    const versions = Object.values(resourcesOf('AWS::Lambda::Version'));
    assert.deepEqual(
      versions.map((version) => version.Properties),
      [{ FunctionName: { Ref: logicalId(core.provider.function) } }],
    );
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /ProvisionedConcurren/);
    template.resourceCountIs('AWS::Lambda::Alias', 0);
  });

  it('maps the caller-journal stream with the §9.5 settings, the on-failure queue and the F-2 filter', () => {
    assert.deepEqual(CONTROLLER_STREAM_SETTINGS, {
      batch_size: 1,
      maximum_batching_window_s: 0,
      parallelization_factor: 1,
      maximum_retry_attempts: 2,
      maximum_record_age_s: 3600,
    });
    const mappings = Object.values(resourcesOf('AWS::Lambda::EventSourceMapping'));
    assert.deepEqual(
      mappings.map((mapping) => mapping.Properties),
      [
        {
          BatchSize: 1,
          BisectBatchOnFunctionError: false,
          DestinationConfig: {
            OnFailure: { Destination: { 'Fn::GetAtt': [logicalId(core.controllerFailureQueue), 'Arn'] } },
          },
          EventSourceArn: { 'Fn::GetAtt': [logicalId(core.tables['caller-journal']), 'StreamArn'] },
          FilterCriteria: { Filters: [{ Pattern: JSON.stringify(CALLER_TIMEOUT_INSERT_FILTER) }] },
          FunctionName: { Ref: logicalId(core.controller.function) },
          MaximumBatchingWindowInSeconds: 0,
          MaximumRecordAgeInSeconds: 3600,
          MaximumRetryAttempts: 2,
          ParallelizationFactor: 1,
          StartingPosition: 'TRIM_HORIZON',
        },
      ],
    );
  });

  it('restates exactly the controller filter, so the mapping and the handler agree (F-2 drift guard)', () => {
    assert.deepEqual(CALLER_TIMEOUT_INSERT_FILTER, CONTROLLER_STREAM_FILTER);
    assert.deepEqual(CALLER_TIMEOUT_INSERT_FILTER, {
      eventName: ['INSERT'],
      dynamodb: { NewImage: { record_type: { S: ['caller_timeout_recorded'] } } },
    });
  });

  it('owns a standard on-failure queue removed with the stack', () => {
    template.hasResource('AWS::SQS::Queue', {
      Properties: { QueueName: 'suc1-3f1c2a9e-controller-failure' },
      DeletionPolicy: 'Delete',
    });
    const queue = Object.values(resourcesOf('AWS::SQS::Queue'))[0];
    assert.equal(queue?.Properties['FifoQueue'], undefined);
    template.resourceCountIs('AWS::SQS::Queue', 1);
  });

  it('grants the provider exactly its §9.6 row', () => {
    const control = logicalId(core.tables.control);
    assert.deepEqual(
      grantsOf(logicalId(core.provider.role)),
      [
        `dynamodb:ConditionCheckItem -> ${arnOf(control)}`,
        `dynamodb:GetItem -> ${arnOf(control)}`,
        `dynamodb:PutItem -> ${arnOf(logicalId(core.tables['experiment-journal']))}`,
        `dynamodb:PutItem -> ${arnOf(logicalId(core.tables.ledger))}`,
        `dynamodb:UpdateItem -> ${arnOf(control)}`,
      ].toSorted(),
    );
  });

  it('grants the controller exactly its §9.6 row: journal put, control read and update, stream read, failure send', () => {
    const control = logicalId(core.tables.control);
    const stream = arnOf(logicalId(core.tables['caller-journal']), 'StreamArn');
    const queue = arnOf(logicalId(core.controllerFailureQueue));
    assert.deepEqual(
      grantsOf(logicalId(core.controller.role)),
      [
        `dynamodb:PutItem -> ${arnOf(logicalId(core.tables['experiment-journal']))}`,
        `dynamodb:GetItem -> ${arnOf(control)}`,
        `dynamodb:UpdateItem -> ${arnOf(control)}`,
        'dynamodb:ListStreams -> "*"',
        `dynamodb:DescribeStream -> ${stream}`,
        `dynamodb:GetRecords -> ${stream}`,
        `dynamodb:GetShardIterator -> ${stream}`,
        `sqs:GetQueueAttributes -> ${queue}`,
        `sqs:GetQueueUrl -> ${queue}`,
        `sqs:SendMessage -> ${queue}`,
      ].toSorted(),
    );
  });

  it('never grants the trial registry or the ledger read to either function', () => {
    const everything = JSON.stringify(resourcesOf('AWS::IAM::Policy'));
    assert.doesNotMatch(everything, new RegExp(logicalId(core.tables['trial-registry'])));
    assert.doesNotMatch(everything, /dynamodb:(Query|Scan|BatchGetItem|BatchWriteItem|DeleteItem|\*)/);
  });

  it('bundles both handlers as ESM with the AWS SDK inlined, loadable on Node', async () => {
    assert.equal(bundleFiles.length, 2);
    for (const bundle of bundleFiles) {
      const code = readFileSync(bundle, 'utf8');
      const staticImports = code.match(/^\s*(?:import|export)\b[^;'"]*["']@aws-sdk\/[^"']*["']/gm) ?? [];
      const dynamicLoads = code.match(/(?<![\w[.])(?:__require|require|import)\(["']@aws-sdk\/[^"']*["']\)/g) ?? [];
      assert.deepEqual([...staticImports, ...dynamicLoads], [], bundle);
      const loaded = (await import(pathToFileURL(bundle).href)) as { readonly handler?: unknown };
      assert.equal(typeof loaded.handler, 'function', bundle);
    }
    template.allResourcesProperties('AWS::Lambda::Function', { Handler: 'index.handler' });
  });
});
