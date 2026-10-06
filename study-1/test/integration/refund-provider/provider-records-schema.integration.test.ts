// Every record the provider emits conforms to its catalogue schema (WP-02 group A and group B):
// each response and each journal event of every provider path goes through the serialization
// kernel to bytes and back before the real Ajv validator reads it, as ingestion will. The test
// fixtures the provider reads (calls, configurations, payment, warm-up request) are checked too,
// so the suites above exercise schema-valid inputs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonDocument } from '../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { RecordType } from '../../../src/record-contract/record-types.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { ProviderHarness } from '../../unit/refund-provider/support/provider-fixtures.ts';
import {
  cleanupRelease,
  executionConfigItem,
  MANIFEST_SHA,
  paymentItem,
  PROBE,
  PROBE_ID,
  probeConfigItem,
  VALIDATION,
  providerHarness,
  OTHER_TRIAL_ID,
  RUN_ID,
  seedExecutionConfiguration,
  seedProbe,
  seedRunTrial,
  signalTimeout,
  TRIAL_ID,
  TRIAL_PK,
  trialConfigItem,
  validCall,
  validProbeCall,
  WARMUP_ID,
} from '../../unit/refund-provider/support/provider-fixtures.ts';
import { startInvocation } from './support/provider-run.ts';

const validator = createRecordValidator();

function assertConforms(type: RecordType, value: unknown): void {
  const parsed = parseJsonDocument(serializeRecordFile(value as StudyRecord));
  assert.ok(parsed.ok, `serialized ${type} did not parse back`);
  const validation = validator.validateAs(type, parsed.value);
  assert.equal(validation.valid, true, `${type}: ${JSON.stringify(validation)}`);
}

function withoutKey(item: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  const { pk: _pk, sk: _sk, ...record } = item;
  return record;
}

function assertJournalConforms(harness: ProviderHarness): number {
  const items = harness.store.itemsIn('experiment_journal');
  for (const item of items) {
    assertConforms(item['record_type'] as RecordType, withoutKey(item));
  }
  return items.length;
}

async function releasedBy(
  release: (harness: ProviderHarness) => Promise<void>,
  advanceMs: number,
): Promise<ProviderHarness> {
  const harness = providerHarness();
  seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
  const running = await startInvocation(harness, validCall());
  await release(harness);
  await harness.time.advanceBy(advanceMs);
  assertConforms('provider_refund_response', await running.result);
  return harness;
}

describe('provider records conform to their schemas', () => {
  it('the inputs: calls, configuration, payment and warm-up request', () => {
    assertConforms('provider_refund_call', validCall());
    assertConforms('provider_refund_call', validProbeCall());
    assertConforms('provider_trial_configuration', withoutKey(trialConfigItem('COMMIT_THEN_TIMEOUT')));
    assertConforms('provider_trial_configuration', withoutKey(probeConfigItem()));
    for (const execution of [undefined, PROBE, VALIDATION]) {
      assertConforms('provider_execution_configuration', withoutKey(executionConfigItem(execution)));
    }
    assertConforms('payment', withoutKey(paymentItem(TRIAL_PK)));
    assertConforms('provider_warmup_request', {
      schema_version: 1,
      record_type: 'provider_warmup_request',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      trial_id: TRIAL_ID,
      warmup_id: WARMUP_ID,
    });
  });

  it('an untargeted commit and a rejection', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    assertConforms('provider_refund_response', await harness.provider.handle(validCall()));
    assertConforms('provider_refund_response', await harness.provider.handle(validCall({ currency: 'USD' })));
    assertConforms('provider_refund_response', await harness.provider.handle(validCall({ attempt_id: 'x' })));
    assert.equal(assertJournalConforms(harness), 9);
  });

  it('unattributed rejections in the execution-level provider partition (A-09)', async () => {
    const harness = providerHarness();
    seedExecutionConfiguration(harness);
    assertConforms('provider_refund_response', await harness.provider.handle(42));
    assertConforms('provider_refund_response', await harness.provider.handle(validCall({ trial_id: OTHER_TRIAL_ID })));
    assert.equal(assertJournalConforms(harness), 2);
  });

  it('a targeted commit released by the signal, by the deadline and by cleanup', async () => {
    const signalled = await releasedBy((harness) => signalTimeout(harness, TRIAL_PK), 250);
    assert.equal(assertJournalConforms(signalled), 6);
    const deadline = await releasedBy(() => Promise.resolve(), 15_000);
    assert.equal(assertJournalConforms(deadline), 5);
    const cleaned = await releasedBy((harness) => cleanupRelease(harness, TRIAL_PK, 'COMMITTED_WAITING'), 250);
    assert.equal(assertJournalConforms(cleaned), 5);
  });

  it('a definitive commit failure', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    harness.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'InternalServerError' },
      { operation: 'transact' },
    );
    await assert.rejects(harness.provider.handle(validCall()));
    assert.equal(assertJournalConforms(harness), 3);
  });

  it('the transport probe and both warm-ups', async () => {
    const probe = providerHarness(PROBE);
    seedProbe(probe);
    const running = await startInvocation(probe, validProbeCall());
    await probe.time.advanceBy(15_000);
    assertConforms('provider_refund_response', await running.result);
    assertConforms(
      'provider_warmup_completed',
      await probe.provider.handle({
        schema_version: 1,
        record_type: 'provider_warmup_request',
        transport_probe_id: PROBE_ID,
        execution_manifest_sha256: MANIFEST_SHA,
        warmup_id: WARMUP_ID,
      }),
    );
    assert.equal(assertJournalConforms(probe), 6);

    const run = providerHarness();
    assertConforms(
      'provider_warmup_completed',
      await run.provider.handle({
        schema_version: 1,
        record_type: 'provider_warmup_request',
        run_id: RUN_ID,
        execution_manifest_sha256: MANIFEST_SHA,
        trial_id: TRIAL_ID,
        warmup_id: WARMUP_ID,
      }),
    );
    assert.equal(assertJournalConforms(run), 1);
  });
});
