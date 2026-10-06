// Synthesis of the Durable variant (design §9.2, §9.4-9.7; OR-RUA-002; BR-RUA-018, BR-RUA-020,
// BR-RUA-050, BR-RUA-053; AC-RUA-053 feed): a FIFO source with a 360 s visibility timeout and a
// FIFO DLQ after two receives, a durable caller (10 s invocations, a 300 s execution timeout
// inside the 900 s event-source limit, 1 day retention) behind its `live` alias with a batch
// size 1 mapping and no batching window, scaling, poller or filter, an environment naming the
// caller journal, the trial registry and the provider's published version, a role that reaches
// only those plus checkpointing its own durable executions, ownership and variant tags, and no
// provisioned concurrency. Real CDK synthesis and local esbuild bundling; Docker is forbidden and
// nothing touches AWS.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  DURABLE_ALIAS_NAME,
  DURABLE_CALLER_TIMEOUT,
  DURABLE_EVENT_SOURCE_LIMIT,
  DURABLE_EXECUTION_ACTIONS,
  DURABLE_EXECUTION_TIMEOUT,
  DURABLE_RETENTION_PERIOD,
  DURABLE_VISIBILITY_TIMEOUT,
  DurableVariant,
} from '../../../infra/constructs/durable-variant.ts';
import { EXPERIMENT_CORE_ID, ExperimentCore } from '../../../infra/constructs/experiment-core.ts';
import { SOURCE_MAX_RECEIVE_COUNT } from '../../../infra/constructs/fifo-message-source.ts';
import { parseExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { logGroupName, queueName, stackName, tableName } from '../../../infra/ownership/resource-naming.ts';
import { DURABLE_ENVIRONMENT_VARIABLES } from '../../../src/durable-variant/durable-environment.ts';
import { DURABLE_RETRY_DELAY_SECONDS, DURABLE_STEP_ATTEMPTS } from '../../../src/durable-variant/durable-retry.ts';
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
let variant: DurableVariant;
let assemblyDirectory = '';

before(() => {
  process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
  outdir = mkdtempSync(join(tmpdir(), 'rua-durable-synth-'));
  const app = new App({ outdir });
  stack = new Stack(app, stackName(context.execution_kind, context.execution_id), {
    env: { account: context.account, region: context.region },
  });
  core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
  variant = new DurableVariant(stack, 'DurableVariant', { context, core });
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

describe('DurableVariant synthesis', () => {
  it('is refused in a transport probe and in a validation of the conventional variant', () => {
    const cases: readonly (readonly [ExecutionSynthContext, string])[] = [
      [
        synthContext('TRANSPORT_PROBE'),
        'DurableVariant in a TRANSPORT_PROBE execution; expected a RUN or VARIANT_VALIDATION (design §9.2)',
      ],
      [
        synthContext('VARIANT_VALIDATION', 'conventional'),
        'DurableVariant in a VARIANT_VALIDATION of variant conventional; expected variant_id durable (design §9.2)',
      ],
    ];
    for (const [otherContext, message] of cases) {
      const other = new Stack(new App(), stackName(otherContext.execution_kind, EXECUTION_ID));
      const otherCore = new ExperimentCore(other, EXPERIMENT_CORE_ID, { context: otherContext });
      assert.throws(() => new DurableVariant(other, 'DurableVariant', { context: otherContext, core: otherCore }), {
        message,
      });
    }
  });

  it('is accepted in a validation of the Durable variant', () => {
    const validation = synthContext('VARIANT_VALIDATION', 'durable');
    const other = new Stack(new App(), stackName(validation.execution_kind, EXECUTION_ID));
    const otherCore = new ExperimentCore(other, EXPERIMENT_CORE_ID, { context: validation });
    const built = new DurableVariant(other, 'DurableVariant', { context: validation, core: otherCore });
    assert.equal(built.alias.aliasName, DURABLE_ALIAS_NAME);
  });

  it('has a FIFO source with a 360 s visibility timeout and a FIFO DLQ after two receives (OR-RUA-002)', () => {
    const source = resource('AWS::SQS::Queue', logicalId(variant.source.queue));
    const dlq = resource('AWS::SQS::Queue', logicalId(variant.source.deadLetterQueue));
    assert.equal(SOURCE_MAX_RECEIVE_COUNT, 2);
    assert.equal(DURABLE_VISIBILITY_TIMEOUT.toSeconds(), 360);
    assert.deepEqual(
      { ...source.Properties, Tags: undefined },
      {
        QueueName: queueName(EXECUTION_ID, 'durable', 'source'),
        FifoQueue: true,
        ContentBasedDeduplication: false,
        VisibilityTimeout: 360,
        RedrivePolicy: {
          deadLetterTargetArn: { 'Fn::GetAtt': [logicalId(variant.source.deadLetterQueue), 'Arn'] },
          maxReceiveCount: 2,
        },
        Tags: undefined,
      },
    );
    assert.deepEqual(
      { ...dlq.Properties, Tags: undefined },
      { QueueName: queueName(EXECUTION_ID, 'durable', 'dlq'), FifoQueue: true, Tags: undefined },
    );
    assert.equal(source.DeletionPolicy, 'Delete');
    assert.equal(dlq.DeletionPolicy, 'Delete');
  });

  it('is a durable function: 10 s invocations, a 300 s execution timeout and 1 day retention (OR-RUA-002)', () => {
    assert.equal(DURABLE_CALLER_TIMEOUT.toSeconds(), 10);
    assert.equal(DURABLE_EXECUTION_TIMEOUT.toSeconds(), 300);
    assert.equal(DURABLE_RETENTION_PERIOD.toDays(), 1);
    assert.equal(callerFunction().Properties['Timeout'], 10);
    assert.deepEqual(callerFunction().Properties['DurableConfig'], { ExecutionTimeout: 300, RetentionPeriodInDays: 1 });
    assert.equal(callerFunction().Properties['FunctionName'], undefined, 'no explicit function name');
  });

  it('nests every timeout inside the next (BR-RUA-053, AC-RUA-053 feed)', () => {
    const deadline = Number(PROVIDER_CLIENT_TIMING.deadline_ns) / 1e9;
    const invocation = DURABLE_CALLER_TIMEOUT.toSeconds();
    const execution = DURABLE_EXECUTION_TIMEOUT.toSeconds();
    assert.ok(deadline < invocation, 'the 3 s provider deadline fires inside one 10 s invocation');
    assert.ok(
      DURABLE_STEP_ATTEMPTS * invocation + (DURABLE_STEP_ATTEMPTS - 1) * DURABLE_RETRY_DELAY_SECONDS <= execution,
      'both step attempts and the 60 s retry delay fit the execution timeout',
    );
    assert.ok(execution <= DURABLE_EVENT_SOURCE_LIMIT.toSeconds(), 'the execution fits the 900 s event-source limit');
    assert.equal(DURABLE_EVENT_SOURCE_LIMIT.toSeconds(), 900);
    assert.ok(DURABLE_VISIBILITY_TIMEOUT.toSeconds() >= execution, 'no redelivery while an execution can still run');
  });

  it('maps the source to the live alias with batch size 1 and no batching window, scaling, poller or filter', () => {
    const versionId = versionIdOf(logicalId(variant.caller.function));
    const aliasId = stack.getLogicalId(variant.alias.node.defaultChild as never);
    assert.deepEqual(resource('AWS::Lambda::Alias', aliasId).Properties, {
      FunctionName: { Ref: logicalId(variant.caller.function) },
      FunctionVersion: { 'Fn::GetAtt': [versionId, 'Version'] },
      Name: 'live',
    });
    assert.deepEqual(stack.resolve(variant.callerVersion.version), { 'Fn::GetAtt': [versionId, 'Version'] });
    const mappings = Object.values(resourcesOf('AWS::Lambda::EventSourceMapping')).filter((mapping) =>
      JSON.stringify(mapping.Properties['EventSourceArn']).includes(logicalId(variant.source.queue)),
    );
    assert.equal(mappings.length, 1);
    assert.deepEqual(
      { ...mappings[0]?.Properties, Tags: undefined },
      {
        // The alias-qualified function name `<name>:live`: a durable function needs a qualified target.
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
    const names = DURABLE_ENVIRONMENT_VARIABLES;
    assert.deepEqual(callerFunction().Properties['Environment'], {
      Variables: {
        [names.execution_kind]: 'RUN',
        [names.execution_id]: EXECUTION_ID,
        [names.caller_journal]: tableName(EXECUTION_ID, 'caller-journal'),
        [names.trial_registry]: tableName(EXECUTION_ID, 'trial-registry'),
        [names.provider_function_name]: { Ref: logicalId(core.provider.function) },
        [names.provider_qualifier]: { 'Fn::GetAtt': [versionIdOf(logicalId(core.provider.function)), 'Version'] },
        [names.variant_id]: 'durable',
      },
    });
  });

  it('may touch only the caller journal, read the registry, consume its source, invoke the provider version and checkpoint its own executions', () => {
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
        {
          Action: [...DURABLE_EXECUTION_ACTIONS],
          Effect: 'Allow',
          Resource: { 'Fn::Join': ['', [{ 'Fn::GetAtt': [logicalId(variant.caller.function), 'Arn'] }, ':*']] },
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
    const role = resource('AWS::IAM::Role', logicalId(variant.caller.role));
    assert.equal(role.Properties['ManagedPolicyArns'], undefined, 'no managed policy with logs:* on *');
  });

  it('keeps the durable grant in its own policy, so the function does not depend on it', () => {
    const policyId = stack.getLogicalId(variant.durableExecutionPolicy.node.defaultChild as never);
    const policy = resource('AWS::IAM::Policy', policyId);
    assert.deepEqual(policy.Properties['Roles'], [{ Ref: logicalId(variant.caller.role) }]);
    const functions = template.toJSON() as {
      readonly Resources: Readonly<Record<string, { readonly DependsOn?: readonly string[] }>>;
    };
    assert.ok(!(functions.Resources[logicalId(variant.caller.function)]?.DependsOn ?? []).includes(policyId));
  });

  it('tags the variant resources with suc:variant_id and has no provisioned concurrency', () => {
    const variantTag = { Key: 'suc:variant_id', Value: 'durable' };
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
    assert.equal(logGroup.Properties['LogGroupName'], logGroupName(EXECUTION_ID, 'durable-caller'));
    assert.equal(logGroup.DeletionPolicy, 'Delete');
    assert.deepEqual(callerFunction().Properties['LoggingConfig'], { LogGroup: { Ref: logGroupId } });
  });

  it('bundles its handler as ESM with the AWS SDK and the durable SDK inlined, loadable on Node', async () => {
    const callerCode = (callerFunction().Properties['Code'] as { readonly S3Key: string }).S3Key.replace(/\.zip$/, '');
    assert.ok(readdirSync(assemblyDirectory).includes(`asset.${callerCode}`));
    const bundle = join(assemblyDirectory, `asset.${callerCode}`, 'index.mjs');
    const code = readFileSync(bundle, 'utf8');
    const staticImports = code.match(/^\s*(?:import|export)\b[^;'"]*["']@aws(?:-sdk)?\/[^"']*["']/gm) ?? [];
    const dynamicLoads = code.match(/(?<![\w[.])(?:__require|require|import)\(["']@aws(?:-sdk)?\/[^"']*["']\)/g) ?? [];
    assert.deepEqual([...staticImports, ...dynamicLoads], []);
    assert.match(code, /durable caller environment invalid/);
    assert.match(code, /refund-attempt/);
    const loaded = (await import(pathToFileURL(bundle).href)) as { readonly handler?: unknown };
    assert.equal(typeof loaded.handler, 'function');
  });
});
