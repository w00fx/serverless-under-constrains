// Synthesis of the transport probe's caller (design §9.2, §9.4, §9.6; BR-RUA-018, BR-RUA-027,
// BR-RUA-053; AC-RUA-002 and AC-RUA-053 feed): deployed only in a probe stack, 10 s timeout, its
// own published version, an environment naming the caller journal and the provider's published
// version, and a role that may touch only the caller journal and invoke only that version. Real
// CDK synthesis and local esbuild bundling; Docker is forbidden and nothing touches AWS.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { EXPERIMENT_CORE_ID, ExperimentCore } from '../../../infra/constructs/experiment-core.ts';
import { PROBE_CALLER_TIMEOUT, ProbeCaller } from '../../../infra/constructs/probe-caller.ts';
import { parseExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { stackName, tableName } from '../../../infra/ownership/resource-naming.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { PROBE_CALLER_ENVIRONMENT_VARIABLES } from '../../../src/transport-probe-caller/probe-caller-environment.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCKER_SENTINEL = join(STUDY_ROOT, 'tools/docker-forbidden.sh');
const EXECUTION_ID = '7a5d0c1e-2f3b-4a6c-8d9e-0f1a2b3c4d5e' as Uuid4;

function synthContext(kind: string): ExecutionSynthContext {
  return parseExecutionSynthContext({
    execution_kind: kind,
    execution_id: EXECUTION_ID,
    account: '123456789012',
    region: 'us-east-1',
    admitted_at: '2026-10-05T12:00:00.000Z',
    total_target_ms: 600_000,
    ...(kind === 'VARIANT_VALIDATION' ? { variant_id: 'durable' } : {}),
  });
}

interface SynthResource {
  readonly Type: string;
  readonly Properties: Readonly<Record<string, unknown>>;
}

const context = synthContext('TRANSPORT_PROBE');
let outdir = '';
let template: Template;
let stack: Stack;
let core: ExperimentCore;
let probe: ProbeCaller;
let assemblyDirectory = '';

before(() => {
  process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
  outdir = mkdtempSync(join(tmpdir(), 'rua-probe-synth-'));
  const app = new App({ outdir });
  stack = new Stack(app, stackName(context.execution_kind, context.execution_id), {
    env: { account: context.account, region: context.region },
  });
  core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
  probe = new ProbeCaller(stack, 'ProbeCaller', { context, core });
  template = Template.fromStack(stack);
  assemblyDirectory = app.synth().directory;
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

function logicalId(construct: { readonly node: { readonly defaultChild?: unknown } }): string {
  return stack.getLogicalId(construct.node.defaultChild as never);
}

// A `currentVersion` logical id carries a hash of the function configuration, so it is read from
// the template: the one version of the provider function.
function providerVersionId(): string {
  const versions = Object.entries(
    template.findResources('AWS::Lambda::Version') as Readonly<Record<string, SynthResource>>,
  );
  const providerRef = JSON.stringify({ Ref: logicalId(core.provider.function) });
  const ids = versions.filter(([, version]) => JSON.stringify(version.Properties['FunctionName']) === providerRef);
  assert.equal(ids.length, 1);
  return ids[0]?.[0] ?? '';
}

function callerFunction(): SynthResource {
  const resource = (template.findResources('AWS::Lambda::Function') as Readonly<Record<string, SynthResource>>)[
    logicalId(probe.caller.function)
  ];
  assert.ok(resource !== undefined, 'the probe caller function is synthesized');
  return resource;
}

describe('ProbeCaller synthesis', () => {
  it('is refused outside a transport-probe execution', () => {
    for (const kind of ['RUN', 'VARIANT_VALIDATION']) {
      const otherContext = synthContext(kind);
      const other = new Stack(new App(), stackName(otherContext.execution_kind, EXECUTION_ID));
      const otherCore = new ExperimentCore(other, EXPERIMENT_CORE_ID, { context: otherContext });
      assert.throws(() => new ProbeCaller(other, 'ProbeCaller', { context: otherContext, core: otherCore }), {
        message: `ProbeCaller in a ${kind} execution; expected TRANSPORT_PROBE (design §9.2)`,
      });
    }
  });

  it('runs with a 10 s timeout and publishes its own version beside the provider version', () => {
    assert.equal(PROBE_CALLER_TIMEOUT.toSeconds(), 10);
    assert.equal(callerFunction().Properties['Timeout'], 10);
    const versions = Object.values(
      template.findResources('AWS::Lambda::Version') as Readonly<Record<string, SynthResource>>,
    );
    assert.deepEqual(
      versions
        .map((version) => version.Properties)
        .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [
        { FunctionName: { Ref: logicalId(core.provider.function) } },
        { FunctionName: { Ref: logicalId(probe.caller.function) } },
      ].toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    );
    assert.doesNotMatch(JSON.stringify(template.toJSON()), /ProvisionedConcurren/);
  });

  it('names the caller journal and the provider published version, never $LATEST, in its environment', () => {
    const names = PROBE_CALLER_ENVIRONMENT_VARIABLES;
    assert.deepEqual(callerFunction().Properties['Environment'], {
      Variables: {
        SUC_EXECUTION_KIND: 'TRANSPORT_PROBE',
        SUC_EXECUTION_ID: EXECUTION_ID,
        [names.caller_journal]: tableName(EXECUTION_ID, 'caller-journal'),
        [names.provider_function_name]: { Ref: logicalId(core.provider.function) },
        [names.provider_qualifier]: {
          'Fn::GetAtt': [providerVersionId(), 'Version'],
        },
      },
    });
  });

  it('may only write the caller journal and invoke the provider published version', () => {
    const roleRef = JSON.stringify([{ Ref: logicalId(probe.caller.role) }]);
    const policies = Object.values(
      template.findResources('AWS::IAM::Policy') as Readonly<Record<string, SynthResource>>,
    );
    const statements = policies
      .filter((policy) => JSON.stringify(policy.Properties['Roles']) === roleRef)
      .flatMap(
        (policy) =>
          (
            policy.Properties['PolicyDocument'] as {
              readonly Statement: readonly { readonly Action: unknown; readonly Resource: unknown }[];
            }
          ).Statement,
      )
      .filter((statement) => !JSON.stringify(statement.Action).includes('logs:'));
    assert.deepEqual(statements, [
      {
        Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:ConditionCheckItem'],
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [logicalId(core.tables['caller-journal']), 'Arn'] },
      },
      {
        Action: 'lambda:InvokeFunction',
        Effect: 'Allow',
        Resource: { Ref: providerVersionId() },
      },
    ]);
  });

  it('bundles its handler as ESM with the AWS SDK inlined, loadable on Node', async () => {
    const assets = readdirSync(assemblyDirectory).filter((name) => name.startsWith('asset.'));
    assert.equal(assets.length, 3);
    const callerCode = (callerFunction().Properties['Code'] as { readonly S3Key: string }).S3Key.replace(/\.zip$/, '');
    const bundle = join(assemblyDirectory, `asset.${callerCode}`, 'index.mjs');
    const code = readFileSync(bundle, 'utf8');
    const staticImports = code.match(/^\s*(?:import|export)\b[^;'"]*["']@aws-sdk\/[^"']*["']/gm) ?? [];
    const dynamicLoads = code.match(/(?<![\w[.])(?:__require|require|import)\(["']@aws-sdk\/[^"']*["']\)/g) ?? [];
    assert.deepEqual([...staticImports, ...dynamicLoads], []);
    assert.match(code, /probe workload request invalid/);
    const loaded = (await import(pathToFileURL(bundle).href)) as { readonly handler?: unknown };
    assert.equal(typeof loaded.handler, 'function');
  });
});
