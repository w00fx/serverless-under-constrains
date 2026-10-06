// The committed transport-scope policy over the real transport (BR-RUA-028, AC-RUA-051 feed):
// WP-08's real ExperimentCore, with the ProbeCaller in the probe stack, is synthesized for a
// TRANSPORT_PROBE stack and a RUN stack, and the scope is recomputed with the committed policy
// over this repository's committed closure through the production git and esbuild adapters.
//
// Selection depends on the CDK `aws:cdk:path` resource metadata, which `cdk synth` (design §9.8
// S1) emits by default and a programmatic `new App()` emits only with the context key
// `aws:cdk:enable-path-metadata`. Both synthesis paths are proven here: with the metadata the
// probe and run scopes agree (no drift); without it the scope is refused with its own reason
// instead of a misleading PROJECTION_SELECTS_NOTHING.
//
// Real CDK synthesis and local esbuild bundling; Docker is forbidden (CDK_DOCKER points at the
// sentinel) and nothing touches AWS. The committed closure is read at HEAD, so a scoped file
// that exists only in the working tree is (correctly) reported as not committed.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { App, Stack } from 'aws-cdk-lib';

import { EXPERIMENT_CORE_ID, ExperimentCore } from '../../../../infra/constructs/experiment-core.ts';
import { ProbeCaller } from '../../../../infra/constructs/probe-caller.ts';
import { parseExecutionSynthContext } from '../../../../infra/ownership/execution-context.ts';
import { stackName } from '../../../../infra/ownership/resource-naming.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { CDK_PATH_METADATA_CONTEXT_KEY } from '../../../../src/transport-qualification/scope/cfn-template.ts';
import { EsbuildBundleInputResolver } from '../../../../src/transport-qualification/scope/node/esbuild-bundle-input-resolver.ts';
import { GitCommittedSourceReader } from '../../../../src/transport-qualification/scope/node/git-committed-source-reader.ts';
import { compareScopeSnapshots } from '../../../../src/transport-qualification/scope/scope-drift.ts';
import { recomputeScopeSnapshot } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import type { ScopeEnvironment } from '../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { SAMPLE_TIMING } from '../../../unit/transport-qualification/scope/support/scope-fixtures.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const DOCKER_SENTINEL = join(STUDY_ROOT, 'tools/docker-forbidden.sh');
const PROBE_EXECUTION_ID = '11111111-2222-4333-8444-555555555555';
const RUN_EXECUTION_ID = '3f1c2a9e-8b4d-4c1e-9f00-1a2b3c4d5e6f';

interface SynthesisOptions {
  readonly kind: 'TRANSPORT_PROBE' | 'RUN';
  readonly executionId: string;
  readonly pathMetadata: boolean;
}

/** Synthesizes one execution stack the way the probe or the run deploys it and returns its template. */
function synthesize(options: SynthesisOptions): JsonObject {
  const context = parseExecutionSynthContext({
    execution_kind: options.kind,
    execution_id: options.executionId,
    account: '123456789012',
    region: 'us-east-1',
    admitted_at: '2026-10-05T12:00:00.000Z',
    total_target_ms: 7_200_000,
  });
  const outdir = mkdtempSync(join(tmpdir(), 'rua-scope-synth-'));
  try {
    const app = new App({
      outdir,
      ...(options.pathMetadata ? { context: { [CDK_PATH_METADATA_CONTEXT_KEY]: true } } : {}),
    });
    const stack = new Stack(app, stackName(context.execution_kind, context.execution_id), {
      env: { account: context.account, region: context.region },
    });
    const core = new ExperimentCore(stack, EXPERIMENT_CORE_ID, { context });
    if (options.kind === 'TRANSPORT_PROBE') {
      new ProbeCaller(stack, 'ProbeCaller', { context, core });
    }
    return app.synth().getStackByName(stack.stackName).template as JsonObject;
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

const validator = createRecordValidator();
const ports = {
  sources: new GitCommittedSourceReader({ projectRoot: STUDY_ROOT }),
  bundles: new EsbuildBundleInputResolver({ projectRoot: STUDY_ROOT }),
  validator,
};

function environment(template: JsonObject): ScopeEnvironment {
  return { template, runtime: {}, timing: SAMPLE_TIMING, provider_warmup: { invocations_per_trial: 1 } };
}

async function snapshotOf(template: JsonObject): Promise<TransportScopeSnapshot> {
  const result = await recomputeScopeSnapshot(environment(template), ports);
  assert.ok(result.ok, `expected a snapshot, got ${JSON.stringify(result)}`);
  return result.value;
}

describe('committed transport-scope policy over the real ExperimentCore', () => {
  let probeTemplate: JsonObject;
  let runTemplate: JsonObject;
  let probe: TransportScopeSnapshot;
  let run: TransportScopeSnapshot;

  before(async () => {
    process.env['CDK_DOCKER'] = DOCKER_SENTINEL;
    probeTemplate = synthesize({ kind: 'TRANSPORT_PROBE', executionId: PROBE_EXECUTION_ID, pathMetadata: true });
    runTemplate = synthesize({ kind: 'RUN', executionId: RUN_EXECUTION_ID, pathMetadata: true });
    probe = await snapshotOf(probeTemplate);
    run = await snapshotOf(runTemplate);
  });

  after(() => {
    delete process.env['CDK_DOCKER'];
  });

  it('computes a probe-stack snapshot the transport_scope_snapshot schema accepts', () => {
    const validation = validator.validateAs('transport_scope_snapshot', JSON.parse(JSON.stringify(probe)) as JsonValue);
    assert.deepEqual(validation.valid ? [] : validation.violations, []);
  });

  it('selects ExperimentCore resources for every committed projection, never the probe caller', () => {
    assert.deepEqual(
      probe.configuration_projections.map((projection) => [projection.projection_id, projection.resources.length]),
      [
        // provider and controller; the ProbeCaller's function lies outside ExperimentCore
        ['experiment_core__functions', 2],
        ['experiment_core__policies', 2],
        ['experiment_core__stream_mappings', 1],
        // the five run-owned tables (design §9.3)
        ['experiment_core__tables', 5],
        ['experiment_core__versions', 1],
      ],
    );
  });

  it('binds the three transport entry points and the bundler options of the real closure', () => {
    assert.deepEqual(probe.entry_points, [
      'src/refund-provider/refund-provider.handler.ts',
      'src/transport-probe-caller/transport-probe-caller.handler.ts',
      'src/treatment-controller/treatment-controller.handler.ts',
    ]);
    assert.deepEqual(probe.runtime_properties, {
      bundle_aws_sdk: true,
      bundle_format: 'esm',
      bundle_main_fields: 'module,main',
      bundle_platform: 'node',
      bundle_target: 'node24',
    });
    for (const name of ['@aws-sdk/client-dynamodb', '@aws-sdk/client-lambda', 'aws-cdk-lib', 'esbuild']) {
      assert.ok(
        probe.dependency_closure.some((dependency) => dependency.name === name),
        `${name} missing from ${JSON.stringify(probe.dependency_closure)}`,
      );
    }
  });

  it('gives a probe stack and a run stack the same scope (no drift)', () => {
    assert.notDeepEqual(probeTemplate, runTemplate);
    assert.deepEqual(compareScopeSnapshots(probe, run).status, 'no_drift');
  });

  it('refuses a template synthesized without construct-path metadata with its own reason', async () => {
    const bare = synthesize({ kind: 'RUN', executionId: RUN_EXECUTION_ID, pathMetadata: false });
    const result = await recomputeScopeSnapshot(environment(bare), ports);
    assert.ok(!result.ok);
    assert.deepEqual(
      result.error.map((reason) => reason.code),
      Array.from({ length: 5 }, () => 'TEMPLATE_WITHOUT_PATH_METADATA'),
    );
    assert.match(result.error[0]?.detail ?? '', /aws:cdk:enable-path-metadata=true\)$/);
  });
});
