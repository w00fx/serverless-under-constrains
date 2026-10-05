// The composed provider over the store emulator on virtual time (BR-RUA-016, BR-RUA-018,
// BR-RUA-025, design §9.3, §9.10): a CONTROL call commits untargeted and returns at once; the
// first call of an armed COMMIT_THEN_TIMEOUT trial commits targeted and waits at the barrier
// until the signal, the safety deadline or cleanup ends the wait; a call that loses the treatment
// race commits untargeted; every partition kind journals in its own partition.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ProviderHarness } from '../../unit/refund-provider/support/provider-fixtures.ts';
import {
  ATTEMPT_ID,
  cleanupRelease,
  field,
  ledgerItems,
  onlyEvent,
  paymentItem,
  PROBE,
  PROBE_ID,
  PROBE_PK,
  providerEvents,
  providerEventTypes,
  providerHarness,
  PROVIDER_REQUEST_ID,
  RUN_ID,
  seedProbe,
  seedRunTrial,
  signalTimeout,
  transactionCount,
  treatmentItem,
  TRIAL_ID,
  TRIAL_PK,
  trialConfigItem,
  VALIDATION,
  VALIDATION_ID,
  validCall,
  validProbeCall,
} from '../../unit/refund-provider/support/provider-fixtures.ts';
import { consumeTreatmentOnAccept, startInvocation } from './support/provider-run.ts';

const UNTARGETED_EVENTS = [
  'provider_call_received',
  'provider_call_accepted',
  'provider_transaction_committed',
  'provider_commit_confirmed',
  'provider_response_returned',
];
const TARGETED_PREFIX = [
  'provider_call_received',
  'provider_call_accepted',
  'provider_transaction_committed',
  'provider_commit_confirmed',
];

function eventId(harness: ProviderHarness, pk: string, type: Parameters<typeof onlyEvent>[2]): JsonValue | undefined {
  return field(onlyEvent(harness, pk, type), 'event_id');
}

function assertSucceeded(response: unknown, harness: ProviderHarness, pk: string): void {
  assert.equal(field(response, 'outcome'), 'SUCCEEDED');
  assert.equal(field(response, 'attempt_id'), ATTEMPT_ID);
  assert.equal(field(response, 'provider_request_id'), PROVIDER_REQUEST_ID);
  const committed = onlyEvent(harness, pk, 'provider_transaction_committed');
  assert.equal(field(response, 'provider_transaction_id'), field(committed, 'provider_transaction_id'));
  assert.equal(field(response, 'provider_call_id'), field(committed, 'provider_call_id'));
}

describe('RefundProvider over the store emulator', () => {
  it('commits a CONTROL call untargeted and returns at once, with the full causal chain', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    const response = await harness.provider.handle(validCall());

    assertSucceeded(response, harness, TRIAL_PK);
    assert.deepEqual(providerEventTypes(harness, TRIAL_PK), UNTARGETED_EVENTS);
    const [received, accepted, committed, confirmed, returned] = providerEvents(harness, TRIAL_PK);
    // The receipt is the root of the call's chain: it has no causation.
    assert.equal(field(received, 'causation_event_ids'), undefined);
    assert.deepEqual(field(accepted, 'causation_event_ids'), [field(received, 'event_id')]);
    assert.deepEqual(field(committed, 'causation_event_ids'), [field(accepted, 'event_id')]);
    assert.deepEqual(field(confirmed, 'causation_event_ids'), [field(committed, 'event_id')]);
    assert.deepEqual(field(returned, 'causation_event_ids'), [field(confirmed, 'event_id')]);
    assert.equal(field(committed, 'targeted'), false);
    assert.equal(field(returned, 'provider_commit_id'), field(committed, 'provider_commit_id'));
    const [ledger] = ledgerItems(harness, TRIAL_PK);
    assert.equal(field(ledger, 'status'), 'SUCCEEDED');
    assert.equal(field(ledger, 'amount_minor'), 10000);
    assert.equal(transactionCount(harness), 1);
    assert.equal(treatmentItem(harness, TRIAL_PK), undefined);
  });

  it('records the canonical payload digest and copies only string identities into the receipt', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    const call = validCall({ provider_request_id: 7 });
    await harness.provider.handle(call);

    const received = onlyEvent(harness, TRIAL_PK, 'provider_call_received');
    assert.equal(field(received, 'raw_request_sha256'), sha256Hex(new TextEncoder().encode(canonicalJson(call))));
    assert.equal(field(received, 'attempt_id'), ATTEMPT_ID);
    assert.equal(field(received, 'provider_request_id'), undefined);
    assert.equal(field(received, 'caller_id'), 'conventional');
  });

  it('echoes only well-formed caller identities on a rejection', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'CONTROL');
    const response = await harness.provider.handle(validCall({ attempt_id: 'not-a-uuid', currency: 'USD' }));

    assert.equal(field(response, 'outcome'), 'REJECTED');
    assert.equal(field(response, 'rejection_reason'), 'IDENTITY_STRUCTURE_INVALID');
    assert.equal(field(response, 'attempt_id'), undefined);
    assert.equal(field(response, 'provider_request_id'), PROVIDER_REQUEST_ID);
  });

  it('rejects a non-object payload in the probe partition, echoing no identity', async () => {
    const harness = providerHarness(PROBE);
    seedProbe(harness);
    const response = await harness.provider.handle('not a call');

    assert.equal(field(response, 'rejection_reason'), 'AUTHORIZATION_FAILED');
    assert.equal(field(response, 'attempt_id'), undefined);
    assert.equal(field(response, 'provider_request_id'), undefined);
    assert.equal(field(onlyEvent(harness, PROBE_PK, 'provider_call_received'), 'caller_id'), undefined);
  });

  it('holds the targeted response until the signal, then observes and releases (BR-RUA-025)', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    const running = await startInvocation(harness, validCall());
    await harness.time.advanceBy(5000);
    assert.equal(running.settled(), false);
    assert.deepEqual(providerEventTypes(harness, TRIAL_PK), TARGETED_PREFIX);
    assert.equal(field(treatmentItem(harness, TRIAL_PK), 'state'), 'COMMITTED_WAITING');

    await signalTimeout(harness, TRIAL_PK);
    await harness.time.advanceBy(250);
    const response = await running.result;

    assertSucceeded(response, harness, TRIAL_PK);
    assert.deepEqual(providerEventTypes(harness, TRIAL_PK), [
      ...TARGETED_PREFIX,
      'treatment_timeout_observed',
      'treatment_response_released',
    ]);
    const committed = onlyEvent(harness, TRIAL_PK, 'provider_transaction_committed');
    assert.equal(field(committed, 'targeted'), true);
    const treatment = treatmentItem(harness, TRIAL_PK);
    assert.equal(field(treatment, 'state'), 'RESPONSE_RELEASED');
    assert.equal(field(treatment, 'targeted_attempt_id'), ATTEMPT_ID);
    assert.equal(field(treatment, 'provider_call_id'), field(response, 'provider_call_id'));
    assert.equal(field(treatment, 'commit_event_id'), field(committed, 'event_id'));
    assert.equal(field(treatment, 'release_event_id'), eventId(harness, TRIAL_PK, 'treatment_response_released'));
  });

  it('safety-releases the targeted response 15 s after the commit when no signal comes', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    const running = await startInvocation(harness, validCall());
    await harness.time.advanceBy(14_999);
    assert.equal(running.settled(), false);
    await harness.time.advanceBy(1);

    assertSucceeded(await running.result, harness, TRIAL_PK);
    const released = onlyEvent(harness, TRIAL_PK, 'treatment_safety_released');
    assert.equal(field(released, 'cause'), 'SAFETY_DEADLINE');
    assert.equal(field(released, 'elapsed_since_commit_ns'), '15000000000');
    assert.deepEqual(field(released, 'causation_event_ids'), [
      eventId(harness, TRIAL_PK, 'provider_transaction_committed'),
    ]);
  });

  it('ends the wait when cleanup safety-releases the treatment, and records it', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    const running = await startInvocation(harness, validCall());
    await cleanupRelease(harness, TRIAL_PK, 'COMMITTED_WAITING');
    await harness.time.advanceBy(250);

    assertSucceeded(await running.result, harness, TRIAL_PK);
    const released = onlyEvent(harness, TRIAL_PK, 'treatment_safety_released');
    assert.equal(field(released, 'cause'), 'CLEANUP_REQUEST');
    assert.equal(field(released, 'from_state'), 'COMMITTED_WAITING');
  });

  it('commits untargeted with fresh identities when another call consumed the treatment first', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    const consumed = { pk: TRIAL_PK, sk: 'treatment', state: 'COMMITTED_WAITING', version: 2 };
    consumeTreatmentOnAccept(harness, consumed);
    const response = await harness.provider.handle(validCall());

    assertSucceeded(response, harness, TRIAL_PK);
    assert.deepEqual(providerEventTypes(harness, TRIAL_PK), UNTARGETED_EVENTS);
    assert.equal(field(onlyEvent(harness, TRIAL_PK, 'provider_transaction_committed'), 'targeted'), false);
    assert.equal(transactionCount(harness), 2);
    const tokens = harness.log
      .entries()
      .filter((entry) => entry.operation === 'TransactWriteItems')
      .map((entry) => field(entry.detail, 'client_request_token'));
    assert.equal(new Set(tokens).size, 2);
    assert.deepEqual(treatmentItem(harness, TRIAL_PK), consumed);
    assert.equal(ledgerItems(harness, TRIAL_PK).length, 1);
  });

  it('commits every later call of the trial untargeted: treatment is consumed once', async () => {
    const harness = providerHarness();
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    const first = await startInvocation(harness, validCall());
    await signalTimeout(harness, TRIAL_PK);
    await harness.time.advanceBy(250);
    await first.result;

    const second = await harness.provider.handle(validCall());
    assert.equal(field(second, 'outcome'), 'SUCCEEDED');
    const committed = providerEvents(harness, TRIAL_PK).filter(
      (event) => event.record_type === 'provider_transaction_committed',
    );
    assert.deepEqual(
      committed.map((event) => field(event, 'targeted')),
      [true, false],
    );
    assert.equal(ledgerItems(harness, TRIAL_PK).length, 2);
    assert.notEqual(field(second, 'provider_call_id'), field(committed[0], 'provider_call_id'));
  });

  it('runs the transport probe in its own probe partition', async () => {
    const harness = providerHarness(PROBE);
    seedProbe(harness);
    const running = await startInvocation(harness, validProbeCall());
    await signalTimeout(harness, PROBE_PK);
    await harness.time.advanceBy(250);

    assertSucceeded(await running.result, harness, PROBE_PK);
    const received = onlyEvent(harness, PROBE_PK, 'provider_call_received');
    assert.equal(field(received, 'transport_probe_id'), PROBE_ID);
    assert.equal(field(received, 'trial_id'), undefined);
    assert.equal(field(treatmentItem(harness, PROBE_PK), 'state'), 'RESPONSE_RELEASED');
  });

  it('serves a variant-validation deployment in the call trial partition', async () => {
    const harness = providerHarness(VALIDATION);
    const pk = `${VALIDATION_ID}#${TRIAL_ID}`;
    const { run_id: _runId, ...config } = trialConfigItem('CONTROL', { pk, variant_validation_id: VALIDATION_ID });
    harness.store.seed('control', config);
    harness.store.seed('control', paymentItem(pk));
    const call = validCall({ variant_validation_id: VALIDATION_ID });
    const { run_id: _callRun, ...validationCall } = call;
    const response = await harness.provider.handle(validationCall);

    assertSucceeded(response, harness, pk);
    assert.equal(field(onlyEvent(harness, pk, 'provider_call_received'), 'variant_validation_id'), VALIDATION_ID);
    assert.equal(field(onlyEvent(harness, pk, 'provider_call_received'), 'run_id'), undefined);
    assert.ok(isUuid4(field(response, 'provider_call_id')));
    assert.notEqual(field(response, 'provider_call_id'), RUN_ID);
  });
});
