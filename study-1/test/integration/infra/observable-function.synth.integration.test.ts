// Synthesis of ObservableFunction and the ownership helpers it relies on (design §9.2, §9.7,
// D-22, RK-11, RK-12, BR-RUA-050). Real CDK synthesis with real local esbuild bundling; Docker
// is forbidden (CDK_DOCKER points at a sentinel that fails), and nothing touches AWS.

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import {
  FUNCTION_MEMORY_MB,
  ObservableFunction,
  RESERVED_ENVIRONMENT_KEYS,
} from '../../../infra/constructs/observable-function.ts';
import {
  EXECUTION_CONTEXT_KEY,
  STUDY_REGION,
  parseExecutionSynthContext,
  readExecutionSynthContext,
} from '../../../infra/ownership/execution-context.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import {
  MANAGED_BY_TAG,
  PROJECT_TAG,
  STUDY_TAG,
  applyOwnershipTags,
  baselineTags,
  executionOwnershipTags,
  variantTag,
} from '../../../infra/ownership/ownership-tags.ts';
import {
  RUN_OWNED_TABLE_ROLES,
  controllerFailureQueueName,
  executionPrefix,
  logGroupName,
  logGroupNamePrefix,
  queueName,
  resourceNamePrefix,
  roleName,
  stackName,
  tableName,
} from '../../../infra/ownership/resource-naming.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

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

let workspace = '';
let template: Template;
let bundleDirectory = '';

before(() => {
  process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
  workspace = mkdtempSync(join(tmpdir(), 'rua-synth-'));
  symlinkSync(join(STUDY_ROOT, 'node_modules'), join(workspace, 'node_modules'), 'dir');
  copyFileSync(join(STUDY_ROOT, 'package-lock.json'), join(workspace, 'package-lock.json'));
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'rua-synth-fixture', private: true, type: 'module' }),
  );
  writeFileSync(
    join(workspace, 'probe.handler.ts'),
    "import { STSClient } from '@aws-sdk/client-sts';\nexport const handler = async (): Promise<string> => `${typeof STSClient}:${process.env['SUC_EXECUTION_ID'] ?? ''}`;\n",
  );
  const outdir = join(workspace, 'cdk.out');
  const app = new App({ outdir });
  const stack = new Stack(app, stackName(context.execution_kind, context.execution_id), {
    env: { account: context.account, region: context.region },
  });
  applyOwnershipTags(stack, executionOwnershipTags(context));
  new ObservableFunction(stack, 'Probe', {
    context,
    logicalName: 'transport-probe',
    entry: join(workspace, 'probe.handler.ts'),
    timeout: Duration.seconds(30),
    environment: { PROBE_MODE: 'commit-then-timeout' },
    durableConfig: { executionTimeout: Duration.minutes(15), retentionPeriod: Duration.days(1) },
    projectRoot: workspace,
    depsLockFilePath: join(workspace, 'package-lock.json'),
  });
  template = Template.fromStack(stack);
  const assembly = app.synth();
  const assetDirectory = readdirSync(assembly.directory).find((name) => name.startsWith('asset.'));
  bundleDirectory = join(assembly.directory, assetDirectory ?? 'missing-asset');
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('ObservableFunction synthesis', () => {
  it('runs Node.js 24 on x86_64 with 512 MB and the durable configuration', () => {
    assert.equal(FUNCTION_MEMORY_MB, 512);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['x86_64'],
      MemorySize: 512,
      Timeout: 30,
      DurableConfig: { ExecutionTimeout: 900, RetentionPeriodInDays: 1 },
    });
  });

  it('sets no function name and no provisioned concurrency', () => {
    const functions = Object.values(template.findResources('AWS::Lambda::Function'));
    assert.equal(functions.length, 1);
    const properties = (functions[0] as { readonly Properties: Readonly<Record<string, unknown>> }).Properties;
    assert.equal('FunctionName' in properties, false);
    assert.equal('ReservedConcurrentExecutions' in properties, false);
    template.resourceCountIs('AWS::Lambda::Version', 0);
    template.resourceCountIs('AWS::Lambda::Alias', 0);
  });

  it('owns an explicit log group removed with the stack', () => {
    template.hasResource('AWS::Logs::LogGroup', {
      Properties: { LogGroupName: `/suc/study-1/${EXECUTION_ID}/transport-probe` },
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
    const fn = Object.values(template.findResources('AWS::Lambda::Function'))[0] as {
      readonly Properties: { readonly LoggingConfig?: { readonly LogGroup?: unknown } };
    };
    assert.notEqual(fn.Properties.LoggingConfig?.LogGroup, undefined);
  });

  it('uses an explicit role that may write only its own log group', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'suc1-3f1c2a9e-transport-probe',
      AssumeRolePolicyDocument: {
        Statement: [{ Action: 'sts:AssumeRole', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' } }],
      },
    });
    const policies = Object.values(template.findResources('AWS::IAM::Policy')) as unknown as readonly {
      readonly Properties: {
        readonly PolicyDocument: {
          readonly Statement: readonly { readonly Action: unknown; readonly Resource: unknown }[];
        };
      };
    }[];
    const statements = policies.flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    assert.ok(statements.length > 0);
    for (const statement of statements) {
      assert.deepEqual(new Set([statement.Action].flat()), new Set(['logs:CreateLogStream', 'logs:PutLogEvents']));
      assert.match(JSON.stringify(statement.Resource), /LogGroup/);
    }
  });

  it('owns the execution environment keys and keeps the caller environment', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: { PROBE_MODE: 'commit-then-timeout', SUC_EXECUTION_KIND: 'RUN', SUC_EXECUTION_ID: EXECUTION_ID },
      },
    });
    assert.deepEqual(RESERVED_ENVIRONMENT_KEYS, ['SUC_EXECUTION_KIND', 'SUC_EXECUTION_ID']);
    const stack = new Stack(new App(), 'Clash');
    assert.throws(
      () =>
        new ObservableFunction(stack, 'Clash', {
          context,
          logicalName: 'clash',
          entry: join(workspace, 'probe.handler.ts'),
          timeout: Duration.seconds(1),
          environment: { SUC_EXECUTION_ID: 'other', SUC_EXECUTION_KIND: 'RUN' },
          projectRoot: workspace,
          depsLockFilePath: join(workspace, 'package-lock.json'),
        }),
      {
        message:
          'environment sets reserved key(s) SUC_EXECUTION_KIND, SUC_EXECUTION_ID; expected ObservableFunction to own them',
      },
    );
  });

  it('tags every taggable resource with the ownership tags', () => {
    const expected = [
      { Key: 'suc:expires_at', Value: '2026-10-05T14:00:00.000Z' },
      { Key: 'suc:managed_by', Value: 'rua-operator-cli' },
      { Key: 'suc:project', Value: 'serverless-under-constraints' },
      { Key: 'suc:run_id', Value: EXECUTION_ID },
      { Key: 'suc:study_id', Value: 'study-1' },
    ];
    for (const type of ['AWS::Lambda::Function', 'AWS::IAM::Role', 'AWS::Logs::LogGroup']) {
      const resources = Object.values(template.findResources(type)) as unknown as readonly {
        readonly Properties: { readonly Tags?: readonly { readonly Key: string; readonly Value: string }[] };
      }[];
      const tags = (resources[0]?.Properties.Tags ?? [])
        .filter((tag) => tag.Key.startsWith('suc:'))
        .toSorted((a, b) => a.Key.localeCompare(b.Key));
      assert.deepEqual(tags, expected, type);
    }
  });

  it('bundles an ESM handler with the AWS SDK inlined and loadable on Node', async () => {
    const bundle = join(bundleDirectory, 'index.mjs');
    const code = readFileSync(bundle, 'utf8');
    // Module references only, not the SDK's own error texts that quote `[require("@aws-sdk/...")]`.
    const staticImports = code.match(/^\s*(?:import|export)\b[^;'"]*["']@aws-sdk\/[^"']*["']/gm) ?? [];
    const dynamicLoads = code.match(/(?<![\w[.])(?:__require|require|import)\(["']@aws-sdk\/[^"']*["']\)/g) ?? [];
    assert.deepEqual([...staticImports, ...dynamicLoads], [], 'the AWS SDK is bundled, not resolved at runtime');
    assert.match(code, /STSClient/);
    assert.match(code, /createRequire\(import\.meta\.url\)/);
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'index.handler' });
    const loaded = (await import(pathToFileURL(bundle).href)) as { readonly handler: () => Promise<string> };
    process.env['SUC_EXECUTION_ID'] = EXECUTION_ID;
    assert.equal(await loaded.handler(), `function:${EXECUTION_ID}`);
  });
});

describe('resource naming', () => {
  it('derives every run-owned name from the execution prefix', () => {
    assert.equal(executionPrefix(EXECUTION_ID), '3f1c2a9e');
    assert.equal(stackName('RUN', EXECUTION_ID), 'SucRua-run-3f1c2a9e');
    assert.equal(stackName('TRANSPORT_PROBE', EXECUTION_ID), 'SucRua-probe-3f1c2a9e');
    assert.equal(stackName('VARIANT_VALIDATION', EXECUTION_ID), 'SucRua-validation-3f1c2a9e');
    assert.equal(resourceNamePrefix(EXECUTION_ID), 'suc1-3f1c2a9e-');
    assert.deepEqual(
      RUN_OWNED_TABLE_ROLES.map((role) => tableName(EXECUTION_ID, role)),
      [
        'suc1-3f1c2a9e-ledger',
        'suc1-3f1c2a9e-experiment-journal',
        'suc1-3f1c2a9e-caller-journal',
        'suc1-3f1c2a9e-control',
        'suc1-3f1c2a9e-trial-registry',
      ],
    );
    assert.equal(queueName(EXECUTION_ID, 'conventional', 'source'), 'suc1-3f1c2a9e-conventional-source.fifo');
    assert.equal(queueName(EXECUTION_ID, 'durable', 'dlq'), 'suc1-3f1c2a9e-durable-dlq.fifo');
    assert.equal(controllerFailureQueueName(EXECUTION_ID), 'suc1-3f1c2a9e-controller-failure');
    assert.equal(logGroupNamePrefix(EXECUTION_ID), `/suc/study-1/${EXECUTION_ID}/`);
    assert.equal(logGroupName(EXECUTION_ID, 'refund-provider'), `/suc/study-1/${EXECUTION_ID}/refund-provider`);
    assert.equal(roleName(EXECUTION_ID, 'refund-provider'), 'suc1-3f1c2a9e-refund-provider');
  });

  it('refuses logical names that are not kebab case and role names over 64 characters', () => {
    for (const bad of ['Refund', 'refund_provider', '-x', '', 'a b']) {
      assert.throws(() => logGroupName(EXECUTION_ID, bad), {
        message: `logical name ${JSON.stringify(bad)}; expected lowercase kebab case ^[a-z][a-z0-9-]*$`,
      });
    }
    assert.equal(roleName(EXECUTION_ID, `a${'b'.repeat(49)}`).length, 64);
    const long = `a${'b'.repeat(50)}`;
    assert.throws(() => roleName(EXECUTION_ID, long), {
      message: `role name "suc1-3f1c2a9e-${long}" has 65 characters; expected at most 64`,
    });
  });
});

describe('ownership tags', () => {
  it('lists the baseline and execution tags', () => {
    assert.deepEqual(baselineTags(), [PROJECT_TAG, STUDY_TAG, MANAGED_BY_TAG]);
    assert.deepEqual(executionOwnershipTags(context).slice(3), [
      { key: 'suc:run_id', value: EXECUTION_ID },
      { key: 'suc:expires_at', value: '2026-10-05T14:00:00.000Z' },
    ]);
    assert.deepEqual(variantTag('durable'), { key: 'suc:variant_id', value: 'durable' });
  });

  it('refuses a tag value DynamoDB would reject', () => {
    assert.throws(
      () => {
        applyOwnershipTags(new Stack(new App(), 'Tagged'), [{ key: 'suc:owner', value: 'a@b' }]);
      },
      {
        message: 'tag suc:owner="a@b" contains "@"; expected DynamoDB-safe characters only',
      },
    );
  });
});

describe('execution synthesis context', () => {
  const valid = {
    execution_kind: 'VARIANT_VALIDATION',
    execution_id: EXECUTION_ID,
    account: '123456789012',
    region: 'us-east-1',
    admitted_at: '2026-10-05T12:00:00.000Z',
    total_target_ms: 1,
    variant_id: 'durable',
  };

  it('accepts a complete context', () => {
    assert.deepEqual(parseExecutionSynthContext(valid), valid);
    assert.equal(STUDY_REGION, 'us-east-1');
  });

  it('lists every problem with the offending value and the expected shape', () => {
    assert.throws(() => parseExecutionSynthContext([]), { message: 'execution context is []; expected a JSON object' });
    assert.throws(() => parseExecutionSynthContext(null), {
      message: 'execution context is null; expected a JSON object',
    });
    const broken = {
      execution_kind: 'TEST',
      execution_id: 'ABC',
      account: 123456789012,
      region: 'eu-west-1',
      admitted_at: '2026-10-05T12:00:00Z',
      total_target_ms: 0,
      variant_id: 'durable',
      extra: 1,
    };
    assert.throws(() => parseExecutionSynthContext(broken), {
      message: [
        'invalid execution context: unknown field "extra"; expected only execution_kind, execution_id, account, region, admitted_at, total_target_ms, variant_id',
        'execution_kind "TEST"; expected one of RUN, TRANSPORT_PROBE, VARIANT_VALIDATION',
        'execution_id "ABC"; expected a lowercase UUIDv4',
        'variant_id "durable"; only a VARIANT_VALIDATION context carries a variant',
        'account 123456789012; expected a 12-digit account id string',
        'region "eu-west-1"; expected "us-east-1"',
        'admitted_at "2026-10-05T12:00:00Z"; expected YYYY-MM-DDTHH:mm:ss.SSSZ',
        'total_target_ms 0; expected a positive safe integer',
      ].join('; '),
    });
    assert.throws(() => parseExecutionSynthContext({ ...valid, variant_id: 'hybrid' }), {
      message:
        'invalid execution context: variant_id "hybrid"; a variant validation needs one of conventional, durable',
    });
    assert.throws(() => parseExecutionSynthContext({ ...valid, account: '12345678901' }), {
      message: 'invalid execution context: account "12345678901"; expected a 12-digit account id string',
    });
    assert.throws(() => parseExecutionSynthContext({ ...valid, total_target_ms: 1.5 }), {
      message: 'invalid execution context: total_target_ms 1.5; expected a positive safe integer',
    });
  });

  it('reads the context file named by the CDK context key', () => {
    const path = join(workspace, 'execution-context.json');
    writeFileSync(path, JSON.stringify(valid));
    assert.deepEqual(readExecutionSynthContext(new App({ context: { [EXECUTION_CONTEXT_KEY]: path } })), valid);
    assert.throws(() => readExecutionSynthContext(new App()), {
      message: 'CDK context suc:execution is undefined; expected the path of execution-context.json',
    });
    assert.throws(() => readExecutionSynthContext(new App({ context: { [EXECUTION_CONTEXT_KEY]: '' } })), {
      message: 'CDK context suc:execution is ""; expected the path of execution-context.json',
    });
  });
});
