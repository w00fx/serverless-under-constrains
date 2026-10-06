// AC-RUA-042 (BR-RUA-016, BR-RUA-018): a received call that fails any acceptance condition is
// rejected with `provider_call_rejected` and a new provider-generated `provider_call_id`; it
// creates no transaction and does not consume treatment. One case per acceptance condition
// (design §14 row 042), each run through the real provider over the InMemoryItemStore emulator
// with an ARMED treatment, so "treatment untouched" is observable. A call that names no
// configured trial is rejected in the execution-level partition `<execution_id>#provider` under
// the execution configuration's digest (Owner amendment A-09, human decision; item 4 cases).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { judgeUnattributedCall } from '../../../src/refund-provider/acceptance.ts';
import type { ProviderRejectionReason } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import type { ProviderHarness } from './support/provider-fixtures.ts';
import {
  armedTreatmentItem,
  ATTEMPT_ID,
  field,
  ledgerItems,
  MANIFEST_SHA,
  OTHER_RUN_ID,
  OTHER_SHA,
  OTHER_TRIAL_ID,
  providerEvents,
  providerEventTypes,
  providerHarness,
  PROVIDER_REQUEST_ID,
  RUN,
  RUN_ID,
  RUN_PROVIDER_PK,
  trialConfigItem,
  seedExecutionConfiguration,
  seedRunTrial,
  transactionCount,
  treatmentItem,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  VALIDATION_ID,
  validCall,
  withoutProperty,
} from './support/provider-fixtures.ts';

/** A trial_id that is not lowercase, so no partition can be derived from it. */
const TRIAL_ID_UPPER = 'BBBBBBBB-0000-4000-8000-000000000001';

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

/** The provider ids of the first unattributed call of a fresh harness: call, instance, event. */
const FIRST_CALL_ID = '99999999-0000-4000-8000-000000000001';
const FIRST_INSTANCE_ID = '99999999-0000-4000-8000-000000000002';
const FIRST_EVENT_ID = '99999999-0000-4000-8000-000000000003';
const UUID4_EXPECTATION = 'expected a lowercase RFC 4122 version-4 UUID';
const ACTIVE_RUN = `RUN ${RUN_ID}`;

/** An armed run trial plus the execution configuration item the runner writes first (A-09). */
function configuredExecution(): ProviderHarness {
  const harness = armedTrial();
  seedExecutionConfiguration(harness);
  return harness;
}

/** The exact `provider_call_rejected` record of the first call of a fresh harness. */
function providerPartitionRejection(reason: ProviderRejectionReason, detail: string): JsonObject {
  return {
    schema_version: 1,
    record_type: 'provider_call_rejected',
    event_id: FIRST_EVENT_ID,
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    occurred_at: '2026-10-05T12:00:00.000Z',
    source: 'refund_provider',
    source_instance_id: FIRST_INSTANCE_ID,
    source_sequence: 1,
    provider_call_id: FIRST_CALL_ID,
    reason,
    detail,
  };
}

async function assertJournaledInProviderPartition(
  raw: JsonValue,
  reason: ProviderRejectionReason,
  detail: string,
): Promise<void> {
  const harness = configuredExecution();
  const response = await harness.provider.handleCall(raw);

  assert.deepEqual(response, {
    schema_version: 1,
    record_type: 'provider_refund_response',
    outcome: 'REJECTED',
    provider_call_id: FIRST_CALL_ID,
    ...(isObjectCall(raw) ? { attempt_id: ATTEMPT_ID, provider_request_id: PROVIDER_REQUEST_ID } : {}),
    rejection_reason: reason,
  });
  assert.deepEqual(providerEvents(harness, RUN_PROVIDER_PK), [providerPartitionRejection(reason, detail)]);
  // Nothing in any trial partition, no transaction, and the armed treatment is untouched.
  assert.equal(harness.store.itemsIn('experiment_journal').length, 1);
  assert.deepEqual(ledgerItems(harness, TRIAL_PK), []);
  assert.equal(transactionCount(harness), 0);
  assert.deepEqual(treatmentItem(harness, TRIAL_PK), armedTreatmentItem(TRIAL_PK));
}

function isObjectCall(raw: JsonValue): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

describe('AC-RUA-042 a call that names no configured trial is journaled at execution level (A-09)', () => {
  it('missing trial_id', async () => {
    await assertJournaledInProviderPartition(
      withoutProperty(validCall(), 'trial_id'),
      'SCHEMA_INVALID',
      `trial_id is absent; ${UUID4_EXPECTATION}`,
    );
  });

  it('malformed trial_id', async () => {
    await assertJournaledInProviderPartition(
      validCall({ trial_id: TRIAL_ID_UPPER }),
      'SCHEMA_INVALID',
      `trial_id is string "${TRIAL_ID_UPPER}"; ${UUID4_EXPECTATION}`,
    );
  });

  it('non-object payload', async () => {
    await assertJournaledInProviderPartition(
      ['provider_refund_call'],
      'SCHEMA_INVALID',
      'call is array ["provider_refund_call"]; expected a provider_refund_call JSON object',
    );
  });

  it('unknown trial (no configuration)', async () => {
    await assertJournaledInProviderPartition(
      validCall({ trial_id: OTHER_TRIAL_ID }),
      'EXECUTION_IDENTITY_MISMATCH',
      `trial ${OTHER_TRIAL_ID} (manifest ${TRIAL_MANIFEST_SHA}); expected a trial configured in the active execution ${ACTIVE_RUN}`,
    );
  });

  it('execution-identity mismatch', async () => {
    await assertJournaledInProviderPartition(
      validCall({ run_id: OTHER_RUN_ID, trial_id: OTHER_TRIAL_ID }),
      'EXECUTION_IDENTITY_MISMATCH',
      `execution RUN ${OTHER_RUN_ID}; expected the active execution ${ACTIVE_RUN}`,
    );
    await assertJournaledInProviderPartition(
      validCall({ execution_manifest_sha256: OTHER_SHA, trial_id: OTHER_TRIAL_ID }),
      'EXECUTION_IDENTITY_MISMATCH',
      `execution_manifest_sha256 ${OTHER_SHA}; expected the frozen manifest ${MANIFEST_SHA}`,
    );
  });

  it('keeps an attributable rejection in its trial partition', async () => {
    const harness = configuredExecution();
    const response = await harness.provider.handleCall(validCall({ run_id: OTHER_RUN_ID }));
    assert.equal(field(response, 'rejection_reason'), 'EXECUTION_IDENTITY_MISMATCH');
    assert.deepEqual(providerEventTypes(harness, TRIAL_PK), ['provider_call_received', 'provider_call_rejected']);
    assert.deepEqual(providerEvents(harness, RUN_PROVIDER_PK), []);
  });

  it('judges an unattributed call from the schema and the execution identity only', () => {
    const ctx = { deployment_execution: RUN, execution_manifest_sha256: MANIFEST_SHA };
    // Check 1 (the registered caller) needs a trial configuration; any schema-valid caller passes.
    assert.deepEqual(judgeUnattributedCall(validCall({ caller_id: 'durable', trial_id: OTHER_TRIAL_ID }), ctx), {
      accepted: false,
      reason: 'EXECUTION_IDENTITY_MISMATCH',
      detail: `trial ${OTHER_TRIAL_ID} (manifest ${TRIAL_MANIFEST_SHA}); expected a trial configured in the active execution ${ACTIVE_RUN}`,
    });
    assert.deepEqual(judgeUnattributedCall(JSON.parse('1e400') as JsonValue, ctx), {
      accepted: false,
      reason: 'SCHEMA_INVALID',
      detail: 'call is number Infinity; expected a provider_refund_call JSON object',
    });
  });
});
