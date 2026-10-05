// AC-RUA-042 (BR-RUA-016, BR-RUA-018): a received call that fails any acceptance condition is
// rejected with `provider_call_rejected` and a new provider-generated `provider_call_id`; it
// creates no transaction and does not consume treatment. One case per acceptance condition
// (design §14 row 042), each run through the real provider over the InMemoryItemStore emulator
// with an ARMED treatment, so "treatment untouched" is observable.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ProviderRejectionReason } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { ProviderHarness } from './support/provider-fixtures.ts';
import {
  armedTreatmentItem,
  ATTEMPT_ID,
  field,
  ledgerItems,
  OTHER_RUN_ID,
  OTHER_SHA,
  providerEvents,
  providerEventTypes,
  providerHarness,
  PROVIDER_REQUEST_ID,
  trialConfigItem,
  seedRunTrial,
  transactionCount,
  treatmentItem,
  TRIAL_PK,
  VALIDATION_ID,
  validCall,
  withoutProperty,
} from './support/provider-fixtures.ts';

/** Every call identity a provider-generated id must differ from. */
const CALLER_IDS = new Set<JsonValue>([ATTEMPT_ID, PROVIDER_REQUEST_ID]);

/** Seeds the armed COMMIT_THEN_TIMEOUT trial; `withPayment: false` leaves the payment out. */
function armedTrial(withPayment = true): ProviderHarness {
  const harness = providerHarness();
  if (withPayment) {
    seedRunTrial(harness, 'COMMIT_THEN_TIMEOUT');
    return harness;
  }
  harness.store.seed('control', trialConfigItem('COMMIT_THEN_TIMEOUT'));
  harness.store.seed('control', armedTreatmentItem(TRIAL_PK));
  return harness;
}

async function assertRejected(raw: JsonValue, reason: ProviderRejectionReason, harness = armedTrial()): Promise<void> {
  const response = await harness.provider.handleCall(raw);

  assert.equal(response.outcome, 'REJECTED', `${JSON.stringify(raw)} was not rejected`);
  assert.equal(field(response, 'rejection_reason'), reason);
  const callId = response.provider_call_id;
  assert.ok(isUuid4(callId), `provider_call_id ${callId} is not a lowercase UUIDv4`);
  assert.ok(!CALLER_IDS.has(callId), 'provider_call_id must be provider-generated, never a caller identity');
  assert.deepEqual(providerEventTypes(harness, TRIAL_PK), ['provider_call_received', 'provider_call_rejected']);
  const [received, rejected] = providerEvents(harness, TRIAL_PK);
  assert.equal(field(received, 'provider_call_id'), callId);
  assert.equal(field(rejected, 'provider_call_id'), callId);
  assert.equal(field(rejected, 'reason'), reason);
  assert.deepEqual(field(rejected, 'causation_event_ids'), [field(received, 'event_id')]);
  // No commit plan ran: no ledger transaction, no transaction at all, treatment still ARMED v1.
  assert.deepEqual(ledgerItems(harness, TRIAL_PK), []);
  assert.equal(transactionCount(harness), 0);
  assert.deepEqual(treatmentItem(harness, TRIAL_PK), armedTreatmentItem(TRIAL_PK));
}

async function assertEachRejected(calls: readonly JsonObject[], reason: ProviderRejectionReason): Promise<void> {
  for (const call of calls) {
    await assertRejected(call, reason);
  }
}

describe('AC-RUA-042 the provider rejects an invalid call', () => {
  it('authorization', async () => {
    await assertEachRejected(
      [
        validCall({ caller_id: 'durable' }),
        validCall({ caller_id: 'probe' }),
        withoutProperty(validCall(), 'caller_id'),
      ],
      'AUTHORIZATION_FAILED',
    );
  });

  it('schema', async () => {
    await assertEachRejected(
      [
        withoutProperty(validCall(), 'refund_request_id'),
        validCall({ approved_amount_minor: 10000 }),
        validCall({ amount_minor: '10000' }),
        validCall({ schema_version: 2 }),
        validCall({ currency: 'brl' }),
        withoutProperty(validCall(), 'trial_manifest_sha256'),
      ],
      'SCHEMA_INVALID',
    );
  });

  it('execution-identity-and-digest', async () => {
    await assertEachRejected(
      [
        validCall({ run_id: OTHER_RUN_ID }),
        { ...withoutProperty(validCall(), 'run_id'), variant_validation_id: VALIDATION_ID },
        validCall({ execution_manifest_sha256: OTHER_SHA }),
        validCall({ trial_manifest_sha256: OTHER_SHA }),
      ],
      'EXECUTION_IDENTITY_MISMATCH',
    );
  });

  it('identity-structure', async () => {
    await assertEachRejected(
      [
        validCall({ attempt_id: ATTEMPT_ID.toUpperCase() }),
        validCall({ provider_request_id: 'dddddddd-0000-1000-8000-000000000002' }),
        validCall({ refund_request_id: ' ref-poc-001' }),
        validCall({ payment_id: '' }),
      ],
      'IDENTITY_STRUCTURE_INVALID',
    );
  });

  it('unknown-payment', async () => {
    await assertRejected(validCall({ payment_id: 'pay-poc-999' }), 'PAYMENT_NOT_FOUND');
    await assertRejected(validCall(), 'PAYMENT_NOT_FOUND', armedTrial(false));
  });

  it('non-positive-or-unsafe-amount', async () => {
    await assertEachRejected(
      [
        validCall({ amount_minor: 0 }),
        validCall({ amount_minor: -10000 }),
        validCall({ amount_minor: 100.5 }),
        validCall({ amount_minor: Number.MAX_SAFE_INTEGER + 1 }),
      ],
      'AMOUNT_INVALID',
    );
  });

  it('currency-mismatch', async () => {
    await assertRejected(validCall({ currency: 'USD' }), 'CURRENCY_MISMATCH');
  });

  it('gives every rejected call its own provider_call_id, even for identical calls', async () => {
    const harness = armedTrial();
    const first = await harness.provider.handleCall(validCall({ currency: 'USD' }));
    const second = await harness.provider.handleCall(validCall({ currency: 'USD' }));
    assert.notEqual(first.provider_call_id, second.provider_call_id);
    assert.deepEqual(
      providerEvents(harness, TRIAL_PK).map((event) => field(event, 'provider_call_id')),
      [first.provider_call_id, first.provider_call_id, second.provider_call_id, second.provider_call_id],
    );
  });
});
