// Conformance of `RecordingPortFactories`, the stand-in for the AWS adapter factories the deferred
// ports build from: each factory records the target it was given and builds a port whose answer
// names that target and differs from every unbound answer (a warm-up transport error named
// `BoundWarmup`, a 200 Invoke response at the bound version, the scripted locators, an empty
// Durable listing, absent DLQ messages), so a deferred-port test can tell bound from unbound.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { DiscoveryTargets } from '../../../src/cleanup/discovery-targets.ts';
import type { CaptureScope } from '../../../src/evidence-collection/capture-scope.ts';
import type { ProbeWorkloadRequest } from '../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type { ProviderWarmupRequest } from '../../../src/record-contract/records/group-b/provider_warmup_request.ts';
import { BOUND_WARMUP_ERROR, RecordingPortFactories } from './support/recording-port-factories.ts';

describe('RecordingPortFactories', () => {
  it('records every build and binds ports that name their target', async () => {
    const factories = new RecordingPortFactories();
    const warmup = factories.warmup({ function_name: 'provider', qualifier: '7' });
    const workload = factories.workload({ function_name: 'caller', version: '3' });
    const telemetry = factories.telemetry({ 'refund-provider': 'provider-fn' });
    const cleanup = factories.cleanup({ stack_ref: 'stack-1' } as unknown as DiscoveryTargets);
    assert.deepEqual(factories.builds, [
      { port: 'warmup', target: 'provider@7' },
      { port: 'workload', target: 'caller@3' },
      { port: 'telemetry', target: '{"refund-provider":"provider-fn"}' },
      { port: 'cleanup', target: 'stack-1' },
    ]);
    assert.equal(factories.cleanupPorts, cleanup);
    assert.deepEqual(await warmup.invokeWarmup({ warmup_id: 'w1' } as unknown as ProviderWarmupRequest), {
      kind: 'transport_error',
      error_name: BOUND_WARMUP_ERROR,
      message: 'provider@7 w1',
    });
    assert.deepEqual(await workload.invokeWorkload({ transport_probe_id: 'p1' } as unknown as ProbeWorkloadRequest), {
      kind: 'response',
      status_code: 200,
      executed_version: '3',
      payload: new TextEncoder().encode('p1'),
    });
    assert.deepEqual(await telemetry.locate('logs', {} as CaptureScope), { ok: true, value: ['provider-fn'] });
    assert.deepEqual(await cleanup.durableExecutions.listRunning('fn'), { ok: true, running_execution_arns: [] });
    assert.deepEqual(await cleanup.dlq.deleteCaptured(['m']), { deleted: [], absent: ['m'], failed: [] });
  });
});
