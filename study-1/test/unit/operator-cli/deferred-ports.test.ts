// The deferred ports of one execution (design §10.2 P2-P7; BR-RUA-050): before P2 latched what a
// port needs it answers the port's own failure value naming TARGET_NOT_DEPLOYED and builds
// nothing; once latched it builds its adapter once from the latched stack and delegates, and it
// rebuilds only when the latch records a new stack. A frozen manifest that cannot bind discovery
// leaves every cleanup port answering that discovery reason.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiscoveredResource } from '../../../src/cleanup/discovery.ts';
import type { CaptureScope } from '../../../src/evidence-collection/capture-scope.ts';
import type { ExecutionTargets, FrozenProvisioningOutcome } from '../../../src/execution-lifecycle/execution-ports.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { DeploymentLatch } from '../../../src/operator-cli/deployment-latch.ts';
import { DeferredBinding, deferredExecutionPorts } from '../../../src/operator-cli/deferred-ports.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { ProbeWorkloadRequest } from '../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type { ResourceManifest } from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import type { ProviderWarmupRequest } from '../../../src/record-contract/records/group-b/provider_warmup_request.ts';
import { frozenCoreFiles } from '../../support/offline-cloud/offline-execution.ts';
import { goldenAdmitted } from './support/golden-admitted.ts';
import { BOUND_WARMUP_ERROR, RecordingPortFactories } from './support/recording-port-factories.ts';

const RUN = goldenAdmitted('run');
const MANIFEST_BYTES = frozenCoreFiles('run').core_files.get(EXECUTION_PATHS.resourceManifest) ?? new Uint8Array();
const MANIFEST = JSON.parse(new TextDecoder().decode(MANIFEST_BYTES)) as ResourceManifest;
const WARMUP = { warmup_id: '00000000-0000-4000-8000-0000000000w1' } as unknown as ProviderWarmupRequest;
const WORKLOAD = { transport_probe_id: '00000000-0000-4000-8000-0000000000p1' } as unknown as ProbeWorkloadRequest;
const SCOPE = { unit: { kind: 'probe' } } as unknown as CaptureScope;
const RESOURCE = { identifier: 'suc1-b42ee7a8-ledger' } as unknown as DiscoveredResource;

const TARGETS: ExecutionTargets = {
  provider_version: '7',
  provider_function_name: 'suc1-b42ee7a8-provider',
  probe_caller: { function_name: 'suc1-b42ee7a8-probe-caller', version: '3' },
  queues: {},
  event_source_mapping_ids: [],
  durable_function_names: [],
  function_names: { 'refund-provider': 'suc1-b42ee7a8-provider' },
};

function frozen(targets?: ExecutionTargets, manifest: ResourceManifest = MANIFEST): FrozenProvisioningOutcome {
  return {
    resource_manifest: manifest,
    resource_manifest_sha256: sha256Hex(MANIFEST_BYTES),
    ...(targets === undefined ? {} : { targets }),
    reasons: [],
  };
}

function notDeployed(problem: string, expected: string): { code: string; subject: string; detail: string } {
  return { code: 'TARGET_NOT_DEPLOYED', subject: 'BR-RUA-050', detail: `${problem}; expected ${expected}` };
}

const NO_STACK = (name: string): ReturnType<typeof notDeployed> =>
  notDeployed(`the ${name} has no deployed stack yet`, 'a resource manifest frozen at P2');

describe('deferredExecutionPorts before P2 latched a stack', () => {
  it('answers each port failure value and builds nothing', async () => {
    const factories = new RecordingPortFactories();
    const ports = deferredExecutionPorts(new DeploymentLatch(), RUN.identity, factories);
    const warmup = NO_STACK('warm-up Invoke');
    assert.deepEqual(await ports.warmup.invokeWarmup(WARMUP), {
      kind: 'transport_error',
      error_name: warmup.code,
      message: warmup.detail,
    });
    const workload = NO_STACK('probe workload Invoke');
    assert.deepEqual(await ports.workload.invokeWorkload(WORKLOAD), {
      kind: 'rejected',
      code: workload.code,
      detail: workload.detail,
    });
    assert.deepEqual(await ports.telemetry.locate('logs', SCOPE), {
      ok: false,
      error: { code: 'TARGET_NOT_DEPLOYED' },
    });
    const cleanup = NO_STACK('cleanup discovery');
    assert.deepEqual(await ports.durableExecutions.listRunning('fn'), { ok: false, reason: cleanup });
    assert.deepEqual(await ports.durableExecutions.stop('arn:exec'), { kind: 'failed', reason: cleanup });
    assert.deepEqual(await ports.dlq.deleteCaptured(['m-1', 'm-2']), {
      deleted: [],
      absent: [],
      failed: [
        { message_id: 'm-1', reason: cleanup },
        { message_id: 'm-2', reason: cleanup },
      ],
    });
    assert.deepEqual(await ports.surfaces.query('tag_index'), { ok: false, reason: cleanup });
    assert.deepEqual(await ports.surfaces.confirmPresence(RESOURCE), { kind: 'failed', reason: cleanup });
    assert.deepEqual(factories.builds, []);
  });
});

describe('deferredExecutionPorts after P2 latched a stack', () => {
  it('builds each port once from the latched targets and delegates to it', async () => {
    const latch = new DeploymentLatch();
    const factories = new RecordingPortFactories();
    const ports = deferredExecutionPorts(latch, RUN.identity, factories);
    latch.record(frozen(TARGETS));
    assert.deepEqual(await ports.warmup.invokeWarmup(WARMUP), {
      kind: 'transport_error',
      error_name: BOUND_WARMUP_ERROR,
      message: `suc1-b42ee7a8-provider@7 ${WARMUP.warmup_id}`,
    });
    await ports.warmup.invokeWarmup(WARMUP);
    const invoked = await ports.workload.invokeWorkload(WORKLOAD);
    assert.equal(invoked.kind === 'response' && invoked.executed_version, '3');
    assert.deepEqual(await ports.telemetry.locate('logs', SCOPE), { ok: true, value: ['suc1-b42ee7a8-provider'] });
    assert.deepEqual(await ports.durableExecutions.listRunning('fn'), { ok: true, running_execution_arns: [] });
    assert.deepEqual(await ports.durableExecutions.stop('arn:exec'), { kind: 'not_running' });
    assert.deepEqual(await ports.dlq.deleteCaptured(['m-1']), { deleted: [], absent: ['m-1'], failed: [] });
    assert.deepEqual(await ports.surfaces.query('tag_index'), { ok: true, resources: [] });
    assert.deepEqual(await ports.surfaces.confirmPresence(RESOURCE), { kind: 'absent' });
    assert.deepEqual(factories.builds, [
      { port: 'warmup', target: 'suc1-b42ee7a8-provider@7' },
      { port: 'workload', target: 'suc1-b42ee7a8-probe-caller@3' },
      { port: 'telemetry', target: '{"refund-provider":"suc1-b42ee7a8-provider"}' },
      { port: 'cleanup', target: MANIFEST.stack_id ?? MANIFEST.stack_name },
    ]);
  });

  it('rebuilds a port only when the latch records a new stack', async () => {
    const latch = new DeploymentLatch();
    const factories = new RecordingPortFactories();
    const ports = deferredExecutionPorts(latch, RUN.identity, factories);
    latch.record(frozen(TARGETS));
    await ports.warmup.invokeWarmup(WARMUP);
    latch.record(frozen({ ...TARGETS, provider_version: '8' }));
    await ports.warmup.invokeWarmup(WARMUP);
    await ports.warmup.invokeWarmup(WARMUP);
    assert.deepEqual(
      factories.builds.map((build) => build.target),
      ['suc1-b42ee7a8-provider@7', 'suc1-b42ee7a8-provider@8'],
    );
  });

  it('answers the missing target when a failed deploy latched a manifest without targets', async () => {
    const latch = new DeploymentLatch();
    const factories = new RecordingPortFactories();
    const ports = deferredExecutionPorts(latch, RUN.identity, factories);
    latch.record(frozen());
    const warmup = notDeployed(
      'the stack outputs name no provider function and version',
      'ProviderFunctionName and ProviderVersion',
    );
    assert.deepEqual(await ports.warmup.invokeWarmup(WARMUP), {
      kind: 'transport_error',
      error_name: warmup.code,
      message: warmup.detail,
    });
    assert.deepEqual(await ports.workload.invokeWorkload(WORKLOAD), {
      kind: 'rejected',
      code: 'TARGET_NOT_DEPLOYED',
      detail: 'the stack outputs name no probe caller; expected ProbeCallerFunctionName and ProbeCallerVersion',
    });
    assert.deepEqual(await ports.telemetry.locate('traces', SCOPE), {
      ok: false,
      error: { code: 'TARGET_NOT_DEPLOYED' },
    });
    assert.deepEqual(await ports.surfaces.query('tag_index'), { ok: true, resources: [] });
    assert.deepEqual(
      factories.builds.map((build) => build.port),
      ['cleanup'],
      'cleanup needs only the frozen manifest',
    );
  });

  it('answers a missing provider function name or version as a missing warm-up target', async () => {
    for (const targets of [
      { ...TARGETS, provider_function_name: undefined },
      { ...TARGETS, provider_version: undefined as unknown as string },
    ]) {
      const latch = new DeploymentLatch();
      const ports = deferredExecutionPorts(latch, RUN.identity, new RecordingPortFactories());
      const { provider_function_name: name, ...rest } = targets;
      latch.record(frozen(name === undefined ? rest : targets));
      const answer = await ports.warmup.invokeWarmup(WARMUP);
      assert.equal(answer.kind === 'transport_error' && answer.error_name, 'TARGET_NOT_DEPLOYED');
    }
  });

  it('answers the discovery reason on every cleanup port when the manifest cannot bind discovery', async () => {
    const latch = new DeploymentLatch();
    const factories = new RecordingPortFactories();
    const probe = goldenAdmitted('probe');
    const ports = deferredExecutionPorts(latch, probe.identity, factories);
    latch.record(frozen(TARGETS));
    const listing = await ports.durableExecutions.listRunning('fn');
    assert.equal(listing.ok, false);
    assert.equal(listing.reason.code, 'DISCOVERY_TARGETS_UNRESOLVED');
    const deletion = await ports.dlq.deleteCaptured(['m-1']);
    assert.deepEqual(
      deletion.failed.map((failure) => failure.reason),
      [listing.reason],
    );
    assert.deepEqual(await ports.surfaces.confirmPresence(RESOURCE), { kind: 'failed', reason: listing.reason });
    assert.deepEqual(factories.builds, []);
  });
});

describe('DeferredBinding', () => {
  it('builds lazily and caches the built result, an error included', () => {
    const latch = new DeploymentLatch();
    let built = 0;
    const binding = new DeferredBinding(latch, 'test port', () => {
      built += 1;
      return { ok: false, error: { code: 'NOPE', subject: 's', detail: 'd' } };
    });
    assert.deepEqual(binding.port(), { ok: false, error: NO_STACK('test port') });
    latch.record(frozen());
    binding.port();
    binding.port();
    assert.equal(built, 1);
  });
});
