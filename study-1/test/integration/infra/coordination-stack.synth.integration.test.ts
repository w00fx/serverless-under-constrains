// Synthesis of the baseline coordination stack `suc-study-1-coordination` (design §9.1, D-08;
// BR-RUA-045, BR-RUA-046, BR-RUA-050; AC-RUA-033 "TTL expiry never establishes release"): one
// on-demand table with string pk/sk, no TTL and no stream, retained with deletion protection,
// tagged with the baseline tags only (never `suc:run_id`), with no function, log group or asset,
// and outputs that name the table and the coordination schema version that
// `src/coordination-lease` writes. Real CDK synthesis; Docker is forbidden and nothing touches AWS.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Token } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { buildCoordinationApp } from '../../../infra/bin/coordination-app.ts';
import {
  COORDINATION_OUTPUTS,
  COORDINATION_REGION,
  COORDINATION_STACK_NAME,
  COORDINATION_TABLE_NAME,
  DECLARED_COORDINATION_SCHEMA_VERSION,
} from '../../../infra/stacks/coordination-stack.ts';
import type { CoordinationStack } from '../../../infra/stacks/coordination-stack.ts';
import { COORDINATION_SCHEMA_VERSION } from '../../../src/coordination-lease/lease-item.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const DOCKER_SENTINEL = join(STUDY_ROOT, 'tools/docker-forbidden.sh');
const ACCOUNT = '123456789012';

interface SynthResource {
  readonly Type: string;
  readonly Properties: Readonly<Record<string, unknown>>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

let outdir = '';
let stack: CoordinationStack;
let template: Template;
let assemblyDirectory = '';

before(() => {
  process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
  outdir = mkdtempSync(join(tmpdir(), 'rua-coordination-synth-'));
  const built = buildCoordinationApp({ CDK_DEFAULT_ACCOUNT: ACCOUNT }, outdir);
  stack = built.stack;
  template = Template.fromStack(stack);
  assemblyDirectory = built.app.synth().directory;
});

after(() => {
  rmSync(outdir, { recursive: true, force: true });
});

function tableResource(): SynthResource {
  const tables = Object.values(
    template.findResources('AWS::DynamoDB::Table') as Readonly<Record<string, SynthResource>>,
  );
  const [table, ...others] = tables;
  assert.ok(table !== undefined && others.length === 0, `expected one table; got ${String(tables.length)}`);
  return table;
}

function tableLogicalId(): string {
  return stack.getLogicalId(stack.table.node.defaultChild as never);
}

describe('coordination stack synthesis', () => {
  it('declares one on-demand table with string pk and sk under the baseline name', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: COORDINATION_TABLE_NAME,
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
    assert.equal(COORDINATION_TABLE_NAME, 'suc-study-1-coordination');
  });

  it('has no TTL attribute and no stream: expiry never deletes the lease', () => {
    const properties = tableResource().Properties;
    assert.equal(Object.hasOwn(properties, 'TimeToLiveSpecification'), false);
    assert.equal(Object.hasOwn(properties, 'StreamSpecification'), false);
  });

  it('is retained and deletion-protected', () => {
    const table = tableResource();
    assert.equal(table.DeletionPolicy, 'Retain');
    assert.equal(table.UpdateReplacePolicy, 'Retain');
    assert.equal(table.Properties['DeletionProtectionEnabled'], true);
  });

  it('carries exactly the baseline tags and never suc:run_id (BR-RUA-050)', () => {
    const tags = tableResource().Properties['Tags'] as readonly { readonly Key: string; readonly Value: string }[];
    assert.deepEqual(
      [...tags].sort((left, right) => left.Key.localeCompare(right.Key)),
      [
        { Key: 'suc:managed_by', Value: 'rua-operator-cli' },
        { Key: 'suc:project', Value: 'serverless-under-constraints' },
        { Key: 'suc:study_id', Value: 'study-1' },
      ],
    );
    const stackTags = JSON.stringify(stack.tags.renderTags());
    assert.equal(stackTags.includes('suc:run_id'), false);
    assert.equal(stackTags.includes('suc:expires_at'), false);
  });

  it('holds the table alone: no function, log group, role or asset', () => {
    const resources = template.toJSON()['Resources'] as Readonly<Record<string, SynthResource>>;
    const types = Object.values(resources)
      .map((resource) => resource.Type)
      .filter((type) => type !== 'AWS::CDK::Metadata');
    assert.deepEqual(types, ['AWS::DynamoDB::Table']);
    const assetEntries = readdirSync(assemblyDirectory).filter((name) => name.startsWith('asset.'));
    assert.deepEqual(assetEntries, []);
  });

  it('outputs the table ARN and name and the coordination schema version src writes', () => {
    const outputs = template.toJSON()['Outputs'] as Readonly<Record<string, { readonly Value: unknown }>>;
    assert.deepEqual(outputs[COORDINATION_OUTPUTS.tableArn]?.Value, { 'Fn::GetAtt': [tableLogicalId(), 'Arn'] });
    assert.deepEqual(outputs[COORDINATION_OUTPUTS.tableName]?.Value, { Ref: tableLogicalId() });
    assert.equal(outputs[COORDINATION_OUTPUTS.schemaVersion]?.Value, String(COORDINATION_SCHEMA_VERSION));
    assert.equal(DECLARED_COORDINATION_SCHEMA_VERSION, COORDINATION_SCHEMA_VERSION);
  });

  it('pins the stack to the account given and us-east-1 under the baseline stack name', () => {
    assert.equal(stack.stackName, COORDINATION_STACK_NAME);
    assert.equal(stack.account, ACCOUNT);
    assert.equal(stack.region, 'us-east-1');
    assert.equal(COORDINATION_REGION, 'us-east-1');
    assert.match(template.toJSON()['Description'] as string, /BR-RUA-045/);
    const manifest = JSON.parse(readFileSync(join(assemblyDirectory, 'manifest.json'), 'utf8')) as {
      readonly artifacts: Readonly<Record<string, { readonly environment?: string }>>;
    };
    assert.equal(manifest.artifacts[COORDINATION_STACK_NAME]?.environment, `aws://${ACCOUNT}/us-east-1`);
  });
});

describe('buildCoordinationApp', () => {
  it('leaves the account to the deployment when the CLI gives none', () => {
    const { stack: agnostic } = buildCoordinationApp({});
    assert.equal(Token.isUnresolved(agnostic.account), true);
    assert.equal(agnostic.region, 'us-east-1');
  });

  it('refuses an account that is not 12 digits', () => {
    for (const account of ['', '12345678901', '1234567890123', '12345678901a']) {
      assert.throws(() => buildCoordinationApp({ CDK_DEFAULT_ACCOUNT: account }), {
        message: `CDK_DEFAULT_ACCOUNT ${JSON.stringify(account)}; expected a 12-digit AWS account id`,
      });
    }
  });

  it('synthesizes as the CDK CLI runs it, with Docker forbidden', () => {
    const cliOut = mkdtempSync(join(tmpdir(), 'rua-coordination-cli-'));
    try {
      const run = spawnSync(process.execPath, [join(STUDY_ROOT, 'infra/bin/coordination-app.ts')], {
        cwd: STUDY_ROOT,
        env: {
          PATH: process.env['PATH'] ?? '',
          CDK_OUTDIR: cliOut,
          CDK_DEFAULT_ACCOUNT: ACCOUNT,
          CDK_DOCKER: DOCKER_SENTINEL,
        },
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, run.stderr);
      const synthesized = JSON.parse(
        readFileSync(join(cliOut, `${COORDINATION_STACK_NAME}.template.json`), 'utf8'),
      ) as {
        readonly Resources: Readonly<Record<string, SynthResource>>;
      };
      const tables = Object.values(synthesized.Resources).filter(
        (resource) => resource.Type === 'AWS::DynamoDB::Table',
      );
      assert.equal(tables.length, 1);
    } finally {
      rmSync(cliOut, { recursive: true, force: true });
    }
  });
});
