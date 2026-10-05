// The provider warm-up through the composed provider (addendum §2, D-27): a warm-up request
// is answered in the execution's `#warmup` partition with a fresh provider_call_id and touches
// no payment, ledger, treatment or trial state; a request it cannot accept or record faults.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  field,
  MANIFEST_SHA,
  OTHER_RUN_ID,
  PROBE,
  PROBE_ID,
  providerEvents,
  providerHarness,
  RUN_ID,
  seedRunTrial,
  TRIAL_ID,
  treatmentItem,
  TRIAL_PK,
  armedTreatmentItem,
  validCall,
  WARMUP_ID,
} from '../../unit/refund-provider/support/provider-fixtures.ts';
import { expectProviderFault } from './support/fault-assertions.ts';

function warmupRequest(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    trial_id: TRIAL_ID,
    warmup_id: WARMUP_ID,
    ...overrides,
  };
}

describe('ProviderWarmup', () => {
  it('records and returns provider_warmup_completed in the warm-up partition, touching nothing else', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    const controlBefore = harness.store.itemsIn('control');
    const completed = await harness.provider.handle(warmupRequest());

    assert.equal(completed.record_type, 'provider_warmup_completed');
    assert.equal(field(completed, 'warmup_id'), WARMUP_ID);
    assert.ok(isUuid4(field(completed, 'provider_call_id')));
    assert.equal(field(completed, 'received_at'), '2026-10-05T12:00:00.000Z');
    assert.equal(field(completed, 'handler_elapsed_ns'), '0');
    assert.equal(field(completed, 'run_id'), RUN_ID);
    assert.equal(field(completed, 'trial_id'), undefined);
    assert.deepEqual(providerEvents(harness, `${RUN_ID}#warmup`), [completed]);
    assert.deepEqual(providerEvents(harness, TRIAL_PK), []);
    assert.deepEqual(harness.store.itemsIn('control'), controlBefore);
    assert.deepEqual(harness.store.itemsIn('ledger'), []);
    assert.deepEqual(treatmentItem(harness, TRIAL_PK), armedTreatmentItem(TRIAL_PK));
  });

  it('warms up the transport probe in its execution-level partition', async () => {
    const harness = providerHarness(PROBE);
    const { run_id: _run, trial_id: _trial, ...request } = warmupRequest({ transport_probe_id: PROBE_ID });
    const completed = await harness.provider.handle(request);
    assert.deepEqual(providerEvents(harness, `${PROBE_ID}#warmup`), [completed]);
  });

  it('refuses a malformed warm-up request', async () => {
    const harness = providerHarness();
    const fault = await expectProviderFault(
      harness.provider.handle(warmupRequest({ warmup_id: 'w' })),
      'WARMUP_REQUEST_INVALID',
      'before_commit',
    );
    assert.match(fault.message, /warmup_id is string "w"/u);
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  // Fuzz seed -667107247 (acceptance.fuzz.test.ts): a refund call whose record_type says
  // provider_warmup_request is routed to the warm-up by that declaration, and refused there.
  it('routes by the declared record type: a refund call declaring a warm-up is refused as one', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    const fault = await expectProviderFault(
      harness.provider.handle(validCall({ record_type: 'provider_warmup_request' })),
      'WARMUP_REQUEST_INVALID',
      'before_commit',
    );
    assert.match(fault.message, /property "caller_id" is not part of provider_warmup_request/u);
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
    assert.deepEqual(harness.store.itemsIn('ledger'), []);
  });

  it('refuses a warm-up addressed to another execution', async () => {
    const harness = providerHarness();
    const fault = await expectProviderFault(
      harness.provider.handle(warmupRequest({ run_id: OTHER_RUN_ID })),
      'WARMUP_REQUEST_INVALID',
      'before_commit',
    );
    assert.equal(
      fault.message,
      `WARMUP_REQUEST_INVALID: warm-up for RUN ${OTHER_RUN_ID}; expected the deployment execution RUN ${RUN_ID}`,
    );
  });

  it('faults JOURNAL_STOPPED when the completion cannot be recorded', async () => {
    const harness = providerHarness();
    harness.store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: false });
    const fault = await expectProviderFault(
      harness.provider.handle(warmupRequest()),
      'JOURNAL_STOPPED',
      'before_commit',
    );
    assert.match(fault.message, /provider_warmup_completed not recorded \(AMBIGUOUS_APPEND\)/u);
  });
});
