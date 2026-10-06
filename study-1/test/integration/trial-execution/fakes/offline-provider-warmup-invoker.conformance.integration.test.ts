// Conformance of OfflineProviderWarmupInvoker to the ProviderWarmupInvoker port (addendum §2.1):
// the warm-up crosses the same emulated Lambda Invoke as the callers' refund calls, so the real
// provider answers with its `provider_warmup_completed`; a scripted settlement replaces the
// Invoke without reaching the provider. Every request is recorded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { warmupRequestOf, warmupSettlementProblem } from '../../../../src/trial-execution/runner-warmup.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { SequentialUuidSource } from '../../../support/kernel/sequential-uuid-source.ts';
import { GOLDEN_PROVIDER_VERSION } from '../../../support/golden-builder/golden-values.ts';
import { OfflineCloud } from '../../../support/offline-cloud/offline-cloud.ts';

describe('OfflineProviderWarmupInvoker conformance', () => {
  it('reaches the real provider, which completes the warm-up', async () => {
    const cloud = new OfflineCloud('run');
    await cloud.startExecution();
    const request = warmupRequestOf(cloud.plan(1), new SequentialUuidSource('42424242'));
    const settlement = await cloud.warmup.invokeWarmup(request);
    assert.equal(
      warmupSettlementProblem(settlement, request, GOLDEN_PROVIDER_VERSION, createRecordValidator()),
      undefined,
    );
    assert.deepEqual(cloud.warmup.requests(), [request]);
  });

  it('settles a scripted warm-up as given, once', async () => {
    const cloud = new OfflineCloud('run');
    await cloud.startExecution();
    const request = warmupRequestOf(cloud.plan(1), new SequentialUuidSource('42424242'));
    const scripted = { kind: 'transport_error', error_name: 'TimeoutError', message: 'timeout' } as const;
    cloud.warmup.failNext(scripted);
    assert.deepEqual(await cloud.warmup.invokeWarmup(request), scripted);
    assert.equal((await cloud.warmup.invokeWarmup(request)).kind, 'response');
    assert.equal(cloud.warmup.requests().length, 2);
  });
});
