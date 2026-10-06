// Composition of the run-owned execution stack by the study app (design §9.1, §9.2, §9.7; D-07,
// D-08; BR-RUA-040, BR-RUA-050): one stack `SucRua-<kind>-<p>` per execution with an explicit
// account and Region; the experiment core always, the probe caller only for a transport probe,
// both variants for a run and only the validated one for a validation; every taggable resource
// with the five `suc:*` tags and the variant resources with their `suc:variant_id`; the outputs
// the runner reads; construct-path metadata on every resource and no CDK metadata resource; and
// the construct paths the deployment readers select by present in the real templates, so the
// projection reads a real run template. The app refuses a missing or invalid context.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildStudyApp } from '../../../infra/bin/study-app.ts';
import { EXECUTION_CONSTRUCT_IDS, EXECUTION_STACK_OUTPUTS } from '../../../infra/stacks/execution-stack.ts';
import { STUDY_APP_ENTRY } from '../../../src/deployment-assembly/cdk-invocations.ts';
import { projectDeploymentTemplate } from '../../../src/deployment-assembly/deployment-projection.ts';
import {
  CORE_TEMPLATE_PATHS,
  readExecutionTemplate,
  templateResourceAt,
  templateResourceUnder,
  VARIANT_CONSTRUCT_IDS,
  variantTemplatePaths,
} from '../../../src/deployment-assembly/execution-template.ts';
import type { ExecutionTemplate } from '../../../src/deployment-assembly/execution-template.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, VariantId } from '../../../src/record-contract/primitives.ts';
import { declaredTags, synthContext } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { STUDY_ROOT, synthesizeExecution } from '../../support/deployment-assembly/study-synth.ts';
import type { SynthesizedExecution } from '../../support/deployment-assembly/study-synth.ts';

const TAGGED_TYPES = [
  'AWS::DynamoDB::Table',
  'AWS::IAM::Role',
  'AWS::Lambda::EventSourceMapping',
  'AWS::Lambda::Function',
  'AWS::Logs::LogGroup',
  'AWS::SQS::Queue',
];
const CORE_OUTPUTS = ['ControllerFailureQueueUrl', 'ControllerFunctionName', 'ProviderFunctionName', 'ProviderVersion'];
const CONVENTIONAL_OUTPUTS = [
  'ConventionalCallerAliasArn',
  'ConventionalCallerFunctionName',
  'ConventionalDeadLetterQueueUrl',
  'ConventionalSourceQueueUrl',
];
const DURABLE_OUTPUTS = [
  'DurableCallerAliasArn',
  'DurableCallerFunctionArn',
  'DurableCallerFunctionName',
  'DurableDeadLetterQueueUrl',
  'DurableSourceQueueUrl',
];
const encoder = new TextEncoder();

let workDir = '';
const executions = new Map<string, SynthesizedExecution>();

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'rua-composition-'));
  executions.set('run', synthesizeExecution(synthContext('RUN'), join(workDir, 'run')));
  executions.set('probe', synthesizeExecution(synthContext('TRANSPORT_PROBE'), join(workDir, 'probe')));
  executions.set(
    'conventional',
    synthesizeExecution(synthContext('VARIANT_VALIDATION', 'conventional'), join(workDir, 'conventional')),
  );
  executions.set(
    'durable',
    synthesizeExecution(synthContext('VARIANT_VALIDATION', 'durable'), join(workDir, 'durable')),
  );
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function execution(name: string): SynthesizedExecution {
  const found = executions.get(name);
  assert.ok(found !== undefined, `${name} was synthesized`);
  return found;
}

function resources(synthesized: SynthesizedExecution): readonly [string, JsonObject][] {
  return Object.entries(synthesized.json['Resources'] as Readonly<Record<string, JsonObject>>);
}

// A template string field, or '' when the field is absent or not a string.
function textOf(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : '';
}

function pathOf(found: JsonObject): string {
  return textOf((found['Metadata'] as JsonObject | undefined)?.['aws:cdk:path']);
}

function topConstructs(synthesized: SynthesizedExecution): readonly string[] {
  return [...new Set(resources(synthesized).map(([, found]) => pathOf(found).split('/')[1] ?? ''))].toSorted();
}

function tagsOf(found: JsonObject): readonly string[] {
  const tags = (found['Properties'] as JsonObject)['Tags'] as
    readonly { readonly Key: string; readonly Value: string }[] | undefined;
  return (tags ?? [])
    .filter((tag) => tag.Key.startsWith('suc:'))
    .map((tag) => `${tag.Key}=${tag.Value}`)
    .toSorted();
}

function templateBytes(synthesized: SynthesizedExecution): Uint8Array {
  return encoder.encode(JSON.stringify(synthesized.json));
}

function checkVariantPaths(template: ExecutionTemplate, variant: VariantId, name: string): void {
  const paths = variantTemplatePaths(variant);
  for (const path of [paths.callerFunction, paths.callerAlias, paths.sourceQueue, paths.deadLetterQueue]) {
    assert.equal(templateResourceAt(template, path).ok, true, `${name} ${path}`);
  }
  const mapping = templateResourceUnder(template, paths.mappingPrefix);
  assert.equal(mapping.ok ? mapping.value.type : '', 'AWS::Lambda::EventSourceMapping');
}

describe('ExecutionStack composition through the study app', () => {
  it('names one stack per execution, with an explicit account and Region and a description', () => {
    const expected = [
      ['run', 'SucRua-run-3f1c2a9e'],
      ['probe', 'SucRua-probe-3f1c2a9e'],
      ['conventional', 'SucRua-validation-3f1c2a9e'],
      ['durable', 'SucRua-validation-3f1c2a9e'],
    ] as const;
    for (const [name, stackName] of expected) {
      const { stack, json } = execution(name);
      assert.deepEqual([stack.stackName, stack.account, stack.region], [stackName, '123456789012', 'us-east-1']);
      assert.match(
        textOf(json['Description']),
        /^Study 1 run-owned (RUN|TRANSPORT_PROBE|VARIANT_VALIDATION) execution 3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f \(CAP-RUA\)\.$/,
      );
    }
  });

  it('composes the core, and the probe caller or the variants each kind deploys', () => {
    const ids = EXECUTION_CONSTRUCT_IDS;
    assert.deepEqual(topConstructs(execution('run')), [ids.conventional, ids.durable, ids.core].toSorted());
    assert.deepEqual(topConstructs(execution('probe')), [ids.core, ids.probeCaller].toSorted());
    assert.deepEqual(topConstructs(execution('conventional')), [ids.conventional, ids.core].toSorted());
    assert.deepEqual(topConstructs(execution('durable')), [ids.durable, ids.core].toSorted());
    const run = execution('run').stack;
    assert.deepEqual(
      [run.probeCaller, execution('probe').stack.conventional, execution('probe').stack.durable],
      [undefined, undefined, undefined],
    );
    assert.deepEqual(
      [execution('conventional').stack.durable, execution('durable').stack.conventional],
      [undefined, undefined],
    );
  });

  it('uses the construct ids the deployment readers select by', () => {
    const fromInfra: Readonly<Record<VariantId, string>> = {
      conventional: EXECUTION_CONSTRUCT_IDS.conventional,
      durable: EXECUTION_CONSTRUCT_IDS.durable,
    };
    assert.deepEqual(VARIANT_CONSTRUCT_IDS, fromInfra);
    assert.ok(Object.values(CORE_TEMPLATE_PATHS).every((path) => path.startsWith(`${EXECUTION_CONSTRUCT_IDS.core}/`)));
  });

  it('places every core and variant resource the readers need at its construct path', () => {
    const deployed: readonly (readonly [string, readonly VariantId[]])[] = [
      ['run', ['conventional', 'durable']],
      ['probe', []],
      ['conventional', ['conventional']],
      ['durable', ['durable']],
    ];
    for (const [name, variants] of deployed) {
      const read = readExecutionTemplate(templateBytes(execution(name)));
      assert.ok(read.ok);
      for (const path of Object.values(CORE_TEMPLATE_PATHS)) {
        assert.equal(templateResourceAt(read.value, path).ok, true, `${name} ${path}`);
      }
      for (const variant of variants) {
        checkVariantPaths(read.value, variant, name);
      }
    }
  });

  it('reads the deployment projection from the real run template', () => {
    const bytes = templateBytes(execution('run'));
    const projected = projectDeploymentTemplate({
      template_path: 'run.template.json',
      template_bytes: bytes,
      template_sha256: sha256Hex(bytes),
    });
    assert.ok(projected.ok, JSON.stringify(projected.ok ? [] : projected.error));
    const { conventional, durable } = projected.value.variants;
    assert.deepEqual(conventional.provider_configuration, durable.provider_configuration);
    assert.deepEqual(conventional.controller_configuration, durable.controller_configuration);
    assert.deepEqual(
      [conventional.caller_strategy['execution_strategy'], durable.caller_strategy['execution_strategy']],
      ['sqs_redelivery', 'durable_step_retry'],
    );
    assert.deepEqual(durable.controller_configuration['starting_position'], 'TRIM_HORIZON');
    assert.deepEqual(conventional.caller_timing, durable.caller_timing);
  });

  it('tags every taggable resource with the five suc:* tags, and variant resources with their variant', () => {
    const base = declaredTags()
      .map((tag) => `${tag.key}=${tag.value}`)
      .toSorted();
    for (const name of ['run', 'probe', 'conventional', 'durable']) {
      for (const [id, found] of resources(execution(name)).filter(([, candidate]) =>
        TAGGED_TYPES.includes(textOf(candidate['Type'])),
      )) {
        const owner = pathOf(found).split('/')[1];
        const variant = Object.entries(VARIANT_CONSTRUCT_IDS).find(([, construct]) => construct === owner)?.[0];
        const expected = variant === undefined ? base : [...base, `suc:variant_id=${variant}`].toSorted();
        assert.deepEqual(tagsOf(found), expected, `${name} ${id}`);
      }
    }
  });

  it('declares the outputs the runner reads, for each kind', () => {
    const outputs = (name: string): readonly string[] =>
      Object.keys(execution(name).json['Outputs'] as JsonObject).toSorted();
    assert.deepEqual(outputs('run'), [...CORE_OUTPUTS, ...CONVENTIONAL_OUTPUTS, ...DURABLE_OUTPUTS].toSorted());
    assert.deepEqual(outputs('probe'), [...CORE_OUTPUTS, 'ProbeCallerFunctionName', 'ProbeCallerVersion'].toSorted());
    assert.deepEqual(outputs('conventional'), [...CORE_OUTPUTS, ...CONVENTIONAL_OUTPUTS].toSorted());
    assert.deepEqual(outputs('durable'), [...CORE_OUTPUTS, ...DURABLE_OUTPUTS].toSorted());
    assert.deepEqual(
      Object.values(EXECUTION_STACK_OUTPUTS).toSorted(),
      [
        ...CORE_OUTPUTS,
        ...CONVENTIONAL_OUTPUTS,
        ...DURABLE_OUTPUTS,
        'ProbeCallerFunctionName',
        'ProbeCallerVersion',
      ].toSorted(),
    );
    const providerVersion = (execution('run').json['Outputs'] as Readonly<Record<string, JsonObject>>)[
      'ProviderVersion'
    ];
    assert.match(
      JSON.stringify(providerVersion?.['Value']),
      /^\{"Fn::GetAtt":\["ExperimentCoreProviderFunctionCurrentVersion[0-9a-f]+","Version"\]\}$/,
    );
  });

  it('keeps construct-path metadata on every resource and declares no CDK metadata resource', () => {
    for (const name of ['run', 'probe', 'conventional', 'durable']) {
      const stackName = execution(name).stack.stackName;
      for (const [id, found] of resources(execution(name))) {
        assert.ok(pathOf(found).startsWith(`${stackName}/`), `${name} ${id}`);
        assert.notEqual(found['Type'], 'AWS::CDK::Metadata');
      }
    }
  });

  it('refuses a missing or invalid execution context', () => {
    assert.throws(
      () => buildStudyApp({ outdir: join(workDir, 'none') }),
      /CDK context suc:execution is undefined; expected the path of execution-context\.json/,
    );
    const invalid = join(workDir, 'invalid-context.json');
    writeFileSync(invalid, JSON.stringify({ execution_kind: 'RUN' }));
    assert.throws(
      () => buildStudyApp({ outdir: join(workDir, 'invalid'), context: { 'suc:execution': invalid } }),
      /invalid execution context/,
    );
  });

  it('is the app cdk.json runs and the one synthesis invokes', () => {
    const cdkJson = JSON.parse(readFileSync(join(STUDY_ROOT, 'cdk.json'), 'utf8')) as { readonly app: string };
    assert.equal(cdkJson.app, `node ${STUDY_APP_ENTRY}`);
  });
});
