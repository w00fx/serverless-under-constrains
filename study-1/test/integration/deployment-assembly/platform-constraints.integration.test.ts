// AC-RUA-053 — Platform and Transport Constraints Hold (BR-RUA-053; design §9.13; addendum §2).
// Given the frozen deployment assembly, inspected before the first mutation: provider-client
// automatic retries are disabled, the immutable provider version is recorded, lower-level timeouts
// cannot preempt the application deadline, and the complete Durable execution fits the direct
// event-source invocation limit. One case per constraint (1-4), the BR-RUA-020 protocol cases
// 4a-4e, the Docker-free and SDK-bundled assembly (4f, 4g), the removal policies (4h), and no
// provisioned concurrency anywhere (addendum §2). The run and probe assemblies are synthesized by
// the study app with local esbuild under the Docker sentinel; the client is the real SDK client
// built through a spying handler factory. Nothing touches AWS.
//
// Case 4g reads each bundle's syntax tree, not its text: every real bundle quotes
// `require("@aws-sdk/signature-v4-crt")` inside an SDK error message, which the inventory's text
// scan (`BARE_AWS_SDK_IMPORT`, src/evidence-package/assembly-inventory.ts) reports as an import, so
// `inventoryAssembly` refuses every real assembly. That defect belongs to WP-13 and is reported by
// WP-24 (decisions file, 2026-10-06); this file asserts the RK-12 property itself.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Template } from 'aws-cdk-lib/assertions';

import { buildCoordinationApp } from '../../../infra/bin/coordination-app.ts';
import { readAssemblyListing } from '../../../src/deployment-assembly/assembly-listing.ts';
import { projectDeploymentTemplate } from '../../../src/deployment-assembly/deployment-projection.ts';
import type { DeploymentTemplateProjection } from '../../../src/deployment-assembly/deployment-projection.ts';
import {
  CORE_TEMPLATE_PATHS,
  providerVersionLogicalId,
  readExecutionTemplate,
  resourceProperties,
  templateResourceAt,
  variantTemplatePaths,
} from '../../../src/deployment-assembly/execution-template.ts';
import { NodeAssemblyFileSystem } from '../../../src/deployment-assembly/node/node-assembly-file-system.ts';
import { buildResourceManifest } from '../../../src/deployment-assembly/resource-manifest.ts';
import { containerAssetFindings } from '../../../src/evidence-package/container-assets.ts';
import { createProviderLambdaClient } from '../../../src/provider-client/aws/provider-lambda-client.ts';
import {
  PROVIDER_CLIENT_TIMING,
  PROVIDER_HTTP_HANDLER_OPTIONS,
} from '../../../src/provider-client/transport-options.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, VariantId } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { loadedModules } from '../../support/deployment-assembly/bundle-imports.ts';
import { synthContext } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { recordedStackResources } from '../../support/deployment-assembly/recorded-stack-resources.ts';
import { succeededInput } from '../../support/deployment-assembly/resource-manifest-inputs.ts';
import { DOCKER_SENTINEL, synthesizeExecution } from '../../support/deployment-assembly/study-synth.ts';
import type { SynthesizedExecution } from '../../support/deployment-assembly/study-synth.ts';
import { SpyHttpHandlerFactory } from '../../support/provider-client/spy-http-handler-factory.ts';

const TEST_CREDENTIALS = { accessKeyId: 'AKIDPLATFORMCASE', secretAccessKey: 'not-a-secret' };
/** The direct event-source invocation limit of a durable execution, in seconds ([R-durable]). */
const EVENT_SOURCE_LIMIT_S = 900;
const DEADLINE_S = Number(PROVIDER_CLIENT_TIMING.deadline_ns / 1_000_000_000n);
const encoder = new TextEncoder();
const VARIANTS: readonly VariantId[] = ['conventional', 'durable'];

let workDir = '';
let run: SynthesizedExecution;
let probe: SynthesizedExecution;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'rua-platform-'));
  run = synthesizeExecution(synthContext('RUN'), join(workDir, 'run'));
  probe = synthesizeExecution(synthContext('TRANSPORT_PROBE'), join(workDir, 'probe'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function templateBytes(execution: SynthesizedExecution): Uint8Array {
  return encoder.encode(JSON.stringify(execution.json));
}

function readModel(execution: SynthesizedExecution): ReturnType<typeof readExecutionTemplate> & { readonly ok: true } {
  const read = readExecutionTemplate(templateBytes(execution));
  assert.ok(read.ok, 'the synthesized template is readable');
  return read;
}

function properties(execution: SynthesizedExecution, path: string): JsonObject {
  const found = templateResourceAt(readModel(execution).value, path);
  assert.ok(found.ok, `${path} is synthesized`);
  return resourceProperties(found.value);
}

function projection(): DeploymentTemplateProjection {
  const bytes = templateBytes(run);
  const projected = projectDeploymentTemplate({
    template_path: 't.json',
    template_bytes: bytes,
    template_sha256: sha256Hex(bytes),
  });
  assert.ok(projected.ok, `projection: ${JSON.stringify(projected.ok ? [] : projected.error)}`);
  return projected.value;
}

function resourcesOf(execution: SynthesizedExecution, type: string): readonly [string, JsonObject][] {
  return Object.entries(execution.template.findResources(type));
}

// The resources of any of the types, across the executions.
function resourcesOfTypes(
  executions: readonly SynthesizedExecution[],
  types: readonly string[],
): readonly [string, JsonObject][] {
  return executions.flatMap((execution) => types.flatMap((type) => resourcesOf(execution, type)));
}

function callerFunctions(): readonly JsonObject[] {
  return [
    ...VARIANTS.map((variant) => properties(run, variantTemplatePaths(variant).callerFunction)),
    properties(probe, 'ProbeCaller/Caller/Function/Resource'),
  ];
}

describe('AC-RUA-053 platform and transport constraints', () => {
  describe('case 1: provider-client automatic retries are disabled', () => {
    const saved = process.env['AWS_MAX_ATTEMPTS'];
    after(() => {
      if (saved === undefined) {
        delete process.env['AWS_MAX_ATTEMPTS'];
        return;
      }
      process.env['AWS_MAX_ATTEMPTS'] = saved;
    });

    it('resolves maxAttempts 1 although AWS_MAX_ATTEMPTS=5', async () => {
      process.env['AWS_MAX_ATTEMPTS'] = '5';
      const client = createProviderLambdaClient(new SpyHttpHandlerFactory().create, { credentials: TEST_CREDENTIALS });
      assert.equal(await client.config.maxAttempts(), 1);
    });
  });

  describe('case 2: the immutable provider version is recorded', () => {
    it('synthesizes exactly one provider version, and every caller invokes it', () => {
      for (const execution of [run, probe]) {
        const read = readModel(execution);
        const versionId = providerVersionLogicalId(read.value);
        assert.ok(versionId.ok);
        const providerId = read.value.byPath.get(CORE_TEMPLATE_PATHS.providerFunction)?.logical_id;
        const publishing = resourcesOf(execution, 'AWS::Lambda::Version').filter(
          ([, version]) =>
            JSON.stringify((version['Properties'] as JsonObject)['FunctionName']) ===
            JSON.stringify({ Ref: providerId }),
        );
        assert.deepEqual(
          publishing.map(([id]) => id),
          [versionId.value],
        );
      }
      const versionId = providerVersionLogicalId(readModel(run).value);
      const probeVersionId = providerVersionLogicalId(readModel(probe).value);
      for (const [caller, id] of callerFunctions().map(
        (caller, index) => [caller, index < 2 ? versionId : probeVersionId] as const,
      )) {
        const qualifier = ((caller['Environment'] as JsonObject)['Variables'] as JsonObject)['SUC_PROVIDER_QUALIFIER'];
        assert.deepEqual(qualifier, { 'Fn::GetAtt': [id.ok ? id.value : '', 'Version'] });
        assert.ok(!JSON.stringify(qualifier).includes('$LATEST'));
      }
    });

    it('records the listed version number in a schema-valid resource manifest', () => {
      const versionId = providerVersionLogicalId(readModel(run).value);
      assert.ok(versionId.ok);
      const built = buildResourceManifest(
        succeededInput({
          provider_version_logical_id: versionId.value,
          resources: recordedStackResources(run.json, '42'),
          configuration: [{ logical_id: versionId.value, attribute_path: 'Version', value: '42' }],
        }),
      );
      assert.ok(built.ok);
      assert.deepEqual(
        [built.value.manifest.provisioning_status, built.value.manifest.provider_version],
        ['succeeded', '42'],
      );
      const verdict = createRecordValidator().validateAs(
        'resource_manifest',
        built.value.manifest as unknown as JsonValue,
      );
      assert.equal(verdict.valid, true);
    });
  });

  describe('case 3: lower-level timeouts cannot preempt the 3 s deadline', () => {
    it('builds the client handler from options that disable every timeout, and uses that handler', () => {
      const factory = new SpyHttpHandlerFactory();
      const client = createProviderLambdaClient(factory.create, { credentials: TEST_CREDENTIALS });
      assert.deepEqual(factory.receivedOptions(), [
        { connectionTimeout: 0, requestTimeout: 0, socketTimeout: 0, throwOnRequestTimeout: false, keepAlive: true },
      ]);
      assert.deepEqual(factory.receivedOptions(), [PROVIDER_HTTP_HANDLER_OPTIONS]);
      assert.equal(client.config.requestHandler, factory.onlyHandler());
    });

    it('gives the provider 30 s and every caller 10 s, both longer than the deadline', () => {
      const provider = properties(run, CORE_TEMPLATE_PATHS.providerFunction);
      assert.equal(provider['Timeout'], 30);
      assert.deepEqual(
        callerFunctions().map((caller) => caller['Timeout']),
        [10, 10, 10],
      );
      assert.ok(30 > DEADLINE_S && 10 > DEADLINE_S, `deadline ${String(DEADLINE_S)} s`);
    });
  });

  describe('case 4: a complete Durable execution fits the direct event-source limit', () => {
    it('bounds the execution at 300 s within 900 s, retains it 1 day, maps the alias, and keeps messages invisible 360 s', () => {
      const durable = properties(run, variantTemplatePaths('durable').callerFunction);
      const config = durable['DurableConfig'] as JsonObject;
      assert.deepEqual(config, { ExecutionTimeout: 300, RetentionPeriodInDays: 1 });
      assert.ok(config.ExecutionTimeout <= EVENT_SOURCE_LIMIT_S);
      assert.equal(projection().variants.durable.message_source_protocol['target_qualifier'], 'alias');
      const visibility = properties(run, variantTemplatePaths('durable').sourceQueue)['VisibilityTimeout'];
      assert.equal(visibility, 360);
      assert.ok((visibility as number) >= config.ExecutionTimeout);
    });
  });

  describe('cases 4a-4e: the BR-RUA-020 message protocol', () => {
    it('4a: every SQS mapping takes one message per batch', () => {
      for (const variant of VARIANTS) {
        assert.equal(projection().variants[variant].message_source_protocol['batch_size'], 1);
      }
    });

    it('4b: no batching window, scaling configuration, provisioned poller or filter on an SQS mapping', () => {
      for (const variant of VARIANTS) {
        const protocol = projection().variants[variant].message_source_protocol;
        assert.deepEqual(
          [
            protocol['maximum_batching_window_s'],
            protocol['scaling_config'],
            protocol['provisioned_poller_config'],
            protocol['filter_criteria'],
          ],
          [null, null, null, null],
        );
      }
    });

    it('4c: a message moves to the DLQ after two receives', () => {
      for (const variant of VARIANTS) {
        assert.equal(projection().variants[variant].message_source_protocol['redrive_max_receive_count'], 2);
      }
    });

    it('4d: both sources and both dead-letter queues are FIFO without content-based deduplication', () => {
      for (const variant of VARIANTS) {
        const protocol = projection().variants[variant].message_source_protocol;
        assert.deepEqual(
          [protocol['fifo'], protocol['dead_letter_queue_fifo'], protocol['content_based_deduplication']],
          [true, true, false],
        );
      }
    });

    it('4e: both sources have the identical protocol, mapped on their alias', () => {
      const { conventional, durable } = projection().variants;
      assert.deepEqual(conventional.message_source_protocol, durable.message_source_protocol);
      assert.equal(conventional.message_source_protocol['target_qualifier'], 'alias');
    });
  });

  describe('cases 4f-4h: the frozen assembly', () => {
    it('4f: is Docker-free: no container asset, every file asset a zipped local directory', async () => {
      assert.equal(process.env['CDK_DOCKER'], DOCKER_SENTINEL);
      for (const execution of [run, probe]) {
        const listing = await readAssemblyListing(new NodeAssemblyFileSystem(), execution.assemblyDir);
        assert.ok(listing.ok);
        const assets = listing.value.files.find((file) => file.path.endsWith('.assets.json'));
        assert.ok(assets !== undefined);
        const manifest = JSON.parse(new TextDecoder().decode(assets.bytes)) as {
          readonly files: Readonly<
            Record<string, { readonly source: { readonly path: string; readonly packaging: string } }>
          >;
          readonly dockerImages: Readonly<Record<string, unknown>>;
        };
        assert.deepEqual(manifest.dockerImages, {});
        const sources = Object.values(manifest.files)
          .map((file) => file.source)
          .filter((source) => source.path.startsWith('asset.'));
        assert.ok(sources.length >= 3);
        for (const source of sources) {
          assert.equal(source.packaging, 'zip');
          assert.ok(
            listing.value.files.some((file) => file.path === `${source.path}/index.mjs`),
            `${source.path} holds index.mjs`,
          );
        }
        assert.deepEqual(containerAssetFindings(listing.value.files), []);
      }
    });

    it('4g (RK-12): every bundle loads only Node built-ins, never a bare @aws-sdk/ module', async () => {
      for (const execution of [run, probe]) {
        const listing = await readAssemblyListing(new NodeAssemblyFileSystem(), execution.assemblyDir);
        assert.ok(listing.ok);
        const bundles = listing.value.files.filter((file) => file.path.endsWith('.mjs'));
        assert.equal(bundles.length, execution === run ? 4 : 3);
        for (const bundle of bundles) {
          const loaded = loadedModules(new TextDecoder().decode(bundle.bytes));
          assert.ok(loaded.includes('node:module'), `${bundle.path} loads ${JSON.stringify(loaded)}`);
          assert.deepEqual(
            loaded.filter((specifier) => !isBuiltin(specifier) || specifier.startsWith('@aws-sdk/')),
            [],
            bundle.path,
          );
        }
      }
    });

    it('4h: every run-owned table, queue and log group is deleted with the stack; coordination is retained', () => {
      const owned = resourcesOfTypes([run, probe], ['AWS::DynamoDB::Table', 'AWS::Logs::LogGroup', 'AWS::SQS::Queue']);
      assert.ok(owned.length > 0);
      for (const [id, found] of owned) {
        assert.deepEqual([found['DeletionPolicy'], found['UpdateReplacePolicy']], ['Delete', 'Delete'], id);
      }
      const coordinationDir = join(workDir, 'coordination');
      const { stack } = buildCoordinationApp({ CDK_DEFAULT_ACCOUNT: '123456789012' }, coordinationDir);
      const tables = Object.values(Template.fromStack(stack).findResources('AWS::DynamoDB::Table')) as JsonObject[];
      const [table, ...others] = tables;
      assert.ok(table !== undefined && others.length === 0, `one coordination table, got ${String(tables.length)}`);
      assert.equal(table['DeletionPolicy'], 'Retain');
      assert.equal((table['Properties'] as JsonObject)['DeletionProtectionEnabled'], true);
    });
  });

  describe('addendum §2: no provisioned concurrency', () => {
    it('declares no ProvisionedConcurrencyConfig on any function, version or alias', () => {
      for (const execution of [run, probe]) {
        assert.ok(!JSON.stringify(execution.json).includes('ProvisionedConcurrencyConfig'));
      }
      const lambdas = resourcesOfTypes(
        [run, probe],
        ['AWS::Lambda::Function', 'AWS::Lambda::Version', 'AWS::Lambda::Alias'],
      );
      assert.ok(lambdas.length > 0);
      for (const [id, found] of lambdas) {
        assert.equal(Object.hasOwn(found['Properties'] as JsonObject, 'ProvisionedConcurrencyConfig'), false, id);
      }
      assert.equal(projection().variants.durable.provider_configuration['provisioned_concurrency_config'], null);
    });
  });
});
