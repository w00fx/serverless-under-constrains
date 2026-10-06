// Synthesis of the conventional variant (design §9.2, §9.4-9.7; OR-RUA-002; BR-RUA-018,
// BR-RUA-020, BR-RUA-050, BR-RUA-053; AC-RUA-053 feed): a FIFO source with a 60 s visibility
// timeout and a FIFO DLQ after two receives, a 10 s caller behind its `live` alias with a batch
// size 1 mapping and no batching window, scaling, poller or filter, an environment naming the
// caller journal, the trial registry and the provider's published version, a role that reaches
// only those, ownership and variant tags, and no provisioned concurrency. Real CDK synthesis and
// local esbuild bundling; Docker is forbidden and nothing touches AWS.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  CONVENTIONAL_ALIAS_NAME,
  CONVENTIONAL_CALLER_TIMEOUT,
  CONVENTIONAL_VISIBILITY_TIMEOUT,
  ConventionalVariant,
} from '../../../infra/constructs/conventional-variant.ts';
import { EXPERIMENT_CORE_ID, ExperimentCore } from '../../../infra/constructs/experiment-core.ts';
import { SOURCE_MAX_RECEIVE_COUNT } from '../../../infra/constructs/fifo-message-source.ts';
import { parseExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { logGroupName, queueName, stackName, tableName } from '../../../infra/ownership/resource-naming.ts';
import { CONVENTIONAL_ENVIRONMENT_VARIABLES } from '../../../src/conventional-variant/conventional-environment.ts';
import { PROVIDER_CLIENT_TIMING } from '../../../src/provider-client/transport-options.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCKER_SENTINEL = join(STUDY_ROOT, 'tools/docker-forbidden.sh');
const EXECUTION_ID = '6b4c9d2e-1a3f-4b5c-9d8e-7f6a5b4c3d2e' as Uuid4;

function synthContext(kind: string, variant?: string): ExecutionSynthContext {
  return parseExecutionSynthContext({
    execution_kind: kind,
    execution_id: EXECUTION_ID,
    account: '123456789012',
    region: 'us-east-1',
    admitted_at: '2026-10-05T12:00:00.000Z',
    total_target_ms: 600_000,
    ...(variant === undefined ? {} : { variant_id: variant }),
  });
}

interface SynthResource {
  readonly Type: string;
  readonly Properties: Readonly<Record<string, unknown>>;
  readonly DeletionPolicy?: string;
}

interface PolicyStatementJson {
  readonly Action: unknown;
  readonly Effect: string;
  readonly Resource: unknown;
}

const context = synthContext('RUN');
let outdir = '';
let template: Template;
let stack: Stack;
let core: ExperimentCore;
let variant: ConventionalVariant;
let assemblyDirectory = '';

before(() => {
  process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
  outdir = mkdtempSync(join(tmpdir(), 'rua-conventional-synth-'));
  const app = new App({ outdir });
  stack = new Stack(app, stackName(context.execution_kind, context.execution_id), {
    env: { account: context.account, region: context.region },
  });
  core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
  variant = new ConventionalVariant(stack, 'ConventionalVariant', { context, core });
  template = Template.fromStack(stack);
  assemblyDirectory = app.synth().directory;
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

function logicalId(construct: { readonly node: { readonly defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as never);
}

function resourcesOf(type: string): Readonly<Record<string, SynthResource>> {
  return template.findResources(type) as Readonly<Record<string, SynthResource>>;
}

function resource(type: string, id: string): SynthResource {
  const found = resourcesOf(type)[id];
  assert.ok(found !== undefined, `${type} ${id} is synthesized`);
  return found;
}

// A `currentVersion` logical id carries a hash of the function configuration, so it is read from
// the template: the one version of `functionId`.
function versionIdOf(functionId: string): string {
  const reference = JSON.stringify({ Ref: functionId });
  const ids = Object.entries(resourcesOf('AWS::Lambda::Version')).filter(
    ([, version]) => JSON.stringify(version.Properties['FunctionName']) === reference,
  );
  assert.equal(ids.length, 1);
  return ids[0]?.[0] ?? '';
}

function callerFunction(): SynthResource {
  return resource('AWS::Lambda::Function', logicalId(variant.caller.function));
}

function callerStatements(): readonly PolicyStatementJson[] {
  const roleRef = JSON.stringify([{ Ref: logicalId(variant.caller.role) }]);
  return Object.values(resourcesOf('AWS::IAM::Policy'))
    .filter((policy) => JSON.stringify(policy.Properties['Roles']) === roleRef)
    .flatMap(
      (policy) =>
        (policy.Properties['PolicyDocument'] as { readonly Statement: readonly PolicyStatementJson[] }).Statement,
    )
    .filter((statement) => !JSON.stringify(statement.Action).includes('logs:'));
}

function tagsOf(found: SynthResource): readonly { readonly Key: string; readonly Value: string }[] {
  return found.Properties['Tags'] as readonly { readonly Key: string; readonly Value: string }[];
}

describe('ConventionalVariant synthesis', () => {
  it('is refused in a transport probe and in a validation of the Durable variant', () => {
    const cases: readonly (readonly [ExecutionSynthContext, string])[] = [
      [
        synthContext('TRANSPORT_PROBE'),
        'ConventionalVariant in a TRANSPORT_PROBE execution; expected a RUN or VARIANT_VALIDATION (design §9.2)',
      ],
      [
        synthContext('VARIANT_VALIDATION', 'durable'),
        'ConventionalVariant in a VARIANT_VALIDATION of variant durable; expected variant_id conventional (design §9.2)',
      ],
    ];
    for (const [otherContext, message] of cases) {
      const other = new Stack(new App(), stackName(otherContext.execution_kind, EXECUTION_ID));
      const otherCore = new ExperimentCore(other, EXPERIMENT_CORE_ID, { context: otherContext });
      assert.throws(
        () => new ConventionalVariant(other, 'ConventionalVariant', { context: otherContext, core: otherCore }),
        {
          message,
        },
      );
    }
  });

  it('is accepted in a validation of the conventional variant', () => {
    const validation = synthContext('VARIANT_VALIDATION', 'conventional');
    const other = new Stack(new App(), stackName(validation.execution_kind, EXECUTION_ID));
    const otherCore = new ExperimentCore(other, EXPERIMENT_CORE_ID, { context: validation });
    const built = new ConventionalVariant(other, 'ConventionalVariant', { context: validation, core: otherCore });
    assert.equal(built.alias.aliasName, CONVENTIONAL_ALIAS_NAME);
  });

  it('has a FIFO source with a 60 s visibility timeout and a FIFO DLQ after two receives (OR-RUA-002)', () => {
    const source = resource('AWS::SQS::Queue', logicalId(variant.source.queue));
    const dlq = resource('AWS::SQS::Queue', logicalId(variant.source.deadLetterQueue));
    assert.equal(SOURCE_MAX_RECEIVE_COUNT, 2);
    assert.equal(CONVENTIONAL_VISIBILITY_TIMEOUT.toSeconds(), 60);
    assert.deepEqual(
      { ...source.Properties, Tags: undefined },
      {
        QueueName: queueName(EXECUTION_ID, 'conventional', 'source'),
        FifoQueue: true,
        ContentBasedDeduplication: false,
        VisibilityTimeout: 60,
        RedrivePolicy: {
          deadLetterTargetArn: { 'Fn::GetAtt': [logicalId(variant.source.deadLetterQueue), 'Arn'] },
          maxReceiveCount: 2,
        },
        Tags: undefined,
      },
    );
    assert.deepEqual(
      { ...dlq.Properties, Tags: undefined },
      { QueueName: queueName(EXECUTION_ID, 'conventional', 'dlq'), FifoQueue: true, Tags: undefined },
    );
    assert.equal(source.DeletionPolicy, 'Delete');
    assert.equal(dlq.DeletionPolicy, 'Delete');
  });

  it('keeps every lower-level timeout above the 3 s provider deadline (AC-RUA-053)', () => {
    assert.equal(CONVENTIONAL_CALLER_TIMEOUT.toSeconds(), 10);
    assert.equal(callerFunction().Properties['Timeout'], 10);
    assert.ok(
      Number(PROVIDER_CLIENT_TIMING.deadline_ns) / 1e9 < CONVENTIONAL_CALLER_TIMEOUT.toSeconds(),
      'the 3 s deadline fires inside the 10 s timeout',
    );
    assert.ok(CONVENTIONAL_VISIBILITY_TIMEOUT.toSeconds() >= 6 * CONVENTIONAL_CALLER_TIMEOUT.toSeconds());
  });

  it('maps the source to the live alias with batch size 1 and no batching window, scaling, poller or filter', () => {
    const versionId = versionIdOf(logicalId(variant.caller.function));
    const aliasId = stack.getLogicalId(variant.alias.node.defaultChild as never);
    assert.deepEqual(resource('AWS::Lambda::Alias', aliasId).Properties, {
      FunctionName: { Ref: logicalId(variant.caller.function) },
      FunctionVersion: { 'Fn::GetAtt': [versionId, 'Version'] },
      Name: 'live',
    });
    const mappings = Object.values(resourcesOf('AWS::Lambda::EventSourceMapping')).filter((mapping) =>
      JSON.stringify(mapping.Properties['EventSourceArn']).includes(logicalId(variant.source.queue)),
    );
    assert.equal(mappings.length, 1);
    assert.deepEqual(
      { ...mappings[0]?.Properties, Tags: undefined },
      {
        // The alias-qualified function name `<name>:live`: the mapping invokes the alias, never $LATEST.
        FunctionName: {
          'Fn::Join': ['', [{ 'Fn::Select': [6, { 'Fn::Split': [':', { Ref: aliasId }] }] }, ':live']],
        },
        EventSourceArn: { 'Fn::GetAtt': [logicalId(variant.source.queue), 'Arn'] },
        BatchSize: 1,
        Tags: undefined,
      },
    );
  });

  it('names its tables, variant and the provider published version, never $LATEST, in its environment', () => {
    const names = CONVENTIONAL_ENVIRONMENT_VARIABLES;
    assert.deepEqual(callerFunction().Properties['Environment'], {
      Variables: {
        [names.execution_kind]: 'RUN',
        [names.execution_id]: EXECUTION_ID,
        [names.caller_journal]: tableName(EXECUTION_ID, 'caller-journal'),
        [names.trial_registry]: tableName(EXECUTION_ID, 'trial-registry'),
        [names.provider_function_name]: { Ref: logicalId(core.provider.function) },
        [names.provider_qualifier]: { 'Fn::GetAtt': [versionIdOf(logicalId(core.provider.function)), 'Version'] },
        [names.variant_id]: 'conventional',
      },
    });
  });

  it('may touch only the caller journal, read the trial registry, consume its source and invoke the provider version', () => {
    const tableArn = (role: 'caller-journal' | 'trial-registry'): unknown => ({
      'Fn::GetAtt': [logicalId(core.tables[role]), 'Arn'],
    });
    const statements = callerStatements();
    const sqsStatements = statements.filter((statement) => JSON.stringify(statement.Action).includes('sqs:'));
    assert.deepEqual(
      statements.filter((statement) => !sqsStatements.includes(statement)),
      [
        {
          Action: [
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:GetItem',
            'dynamodb:ConditionCheckItem',
            'dynamodb:Query',
          ],
          Effect: 'Allow',
          Resource: tableArn('caller-journal'),
        },
        { Action: 'dynamodb:GetItem', Effect: 'Allow', Resource: tableArn('trial-registry') },
        {
          Action: 'lambda:InvokeFunction',
          Effect: 'Allow',
          Resource: { Ref: versionIdOf(logicalId(core.provider.function)) },
        },
      ],
    );
    assert.deepEqual(
      sqsStatements.map((statement) => statement.Resource),
      [{ 'Fn::GetAtt': [logicalId(variant.source.queue), 'Arn'] }],
    );
    const forbidden = (['ledger', 'control', 'experiment-journal'] as const).map((role) =>
      logicalId(core.tables[role]),
    );
    for (const id of forbidden) {
      assert.doesNotMatch(JSON.stringify(statements), new RegExp(id));
    }
  });

  it('tags the variant resources with suc:variant_id and has no provisioned concurrency', () => {
    const variantTag = { Key: 'suc:variant_id', Value: 'conventional' };
    for (const found of [
      callerFunction(),
      resource('AWS::SQS::Queue', logicalId(variant.source.queue)),
      resource('AWS::SQS::Queue', logicalId(variant.source.deadLetterQueue)),
    ]) {
      assert.ok(tagsOf(found).some((tag) => tag.Key === variantTag.Key && tag.Value === variantTag.Value));
    }
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /ProvisionedConcurren/);
  });

  it('writes to its own explicit log group, removed with the stack (A-13)', () => {
    const logGroupId = logicalId(variant.caller.logGroup);
    const logGroup = resource('AWS::Logs::LogGroup', logGroupId);
    assert.equal(logGroup.Properties['LogGroupName'], logGroupName(EXECUTION_ID, 'conventional-caller'));
    assert.equal(logGroup.DeletionPolicy, 'Delete');
    assert.deepEqual(callerFunction().Properties['LoggingConfig'], { LogGroup: { Ref: logGroupId } });
  });

  it('bundles its handler as ESM with the AWS SDK inlined, loadable on Node', async () => {
    const callerCode = (callerFunction().Properties['Code'] as { readonly S3Key: string }).S3Key.replace(/\.zip$/, '');
    assert.ok(readdirSync(assemblyDirectory).includes(`asset.${callerCode}`));
    const bundle = join(assemblyDirectory, `asset.${callerCode}`, 'index.mjs');
    const code = readFileSync(bundle, 'utf8');
    const staticImports = code.match(/^\s*(?:import|export)\b[^;'"]*["']@aws-sdk\/[^"']*["']/gm) ?? [];
    const dynamicLoads = code.match(/(?<![\w[.])(?:__require|require|import)\(["']@aws-sdk\/[^"']*["']\)/g) ?? [];
    assert.deepEqual([...staticImports, ...dynamicLoads], []);
    assert.match(code, /conventional caller environment invalid/);
    const loaded = (await import(pathToFileURL(bundle).href)) as { readonly handler?: unknown };
    assert.equal(typeof loaded.handler, 'function');
  });
});
