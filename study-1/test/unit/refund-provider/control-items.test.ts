// The control-item readers (design §9.3): a configuration, payment or treatment item is read
// only when every attribute the provider acts on is well formed, and a refusal names the item
// key, the offending value and the expected shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import {
  decodeConfigItem,
  decodePaymentItem,
  decodeTreatmentItem,
  paymentSortKey,
} from '../../../src/refund-provider/control-items.ts';
import {
  MANIFEST_SHA,
  OTHER_TRIAL_ID,
  PAYMENT_ID,
  paymentItem,
  PROBE_PK,
  probeConfigItem,
  SIGNAL_EVENT_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  trialConfigItem,
} from './support/provider-fixtures.ts';

function refusal(result: Result<unknown, string>): string {
  assert.equal(result.ok, false);
  return result.error;
}

describe('decodeConfigItem', () => {
  it('reads a trial configuration with its trial and a probe configuration without one', () => {
    assert.deepEqual(decodeConfigItem(trialConfigItem('CONTROL'), TRIAL_ID), {
      ok: true,
      value: {
        execution_manifest_sha256: MANIFEST_SHA,
        registered_caller_id: 'conventional',
        scenario: 'CONTROL',
        payment_id: PAYMENT_ID,
        trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
      },
    });
    assert.deepEqual(decodeConfigItem(probeConfigItem(), undefined), {
      ok: true,
      value: {
        execution_manifest_sha256: MANIFEST_SHA,
        registered_caller_id: 'probe',
        scenario: 'COMMIT_THEN_TIMEOUT',
        payment_id: PAYMENT_ID,
      },
    });
  });

  it('refuses a configuration of another trial or with a malformed trial digest', () => {
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL'), OTHER_TRIAL_ID)),
      `control item ${TRIAL_PK}/config: trial_id string "${TRIAL_ID}"; expected the partition trial ${OTHER_TRIAL_ID}`,
    );
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL', { trial_manifest_sha256: 'x' }), TRIAL_ID)),
      `control item ${TRIAL_PK}/config: trial_manifest_sha256 string "x"; expected 64 lowercase hex digits`,
    );
  });

  // WP-07 review round 1: the provider runs the coded OR-RUA-002 timing, so a configuration
  // declaring other values would make the evidence misdescribe the run.
  it('refuses a configuration whose declared barrier timing differs from the coded timing', () => {
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL', { safety_release_ms: 14999 }), TRIAL_ID)),
      `control item ${TRIAL_PK}/config: safety_release_ms number 14999; expected 15000, the provider's coded OR-RUA-002 value`,
    );
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL', { safety_release_ms: '15000' }), TRIAL_ID)),
      `control item ${TRIAL_PK}/config: safety_release_ms string "15000"; expected 15000, the provider's coded OR-RUA-002 value`,
    );
    assert.equal(
      refusal(decodeConfigItem(probeConfigItem({ treatment_poll_interval_ms: 251 }), undefined)),
      `control item ${PROBE_PK}/config: treatment_poll_interval_ms number 251; expected 250, the provider's coded OR-RUA-002 value`,
    );
    const { treatment_poll_interval_ms: _omitted, ...withoutPoll } = trialConfigItem('CONTROL');
    assert.equal(
      refusal(decodeConfigItem(withoutPoll, TRIAL_ID)),
      `control item ${TRIAL_PK}/config: treatment_poll_interval_ms absent; expected 250, the provider's coded OR-RUA-002 value`,
    );
  });

  it('refuses a probe configuration that carries a trial identity', () => {
    assert.equal(
      refusal(decodeConfigItem(probeConfigItem({ trial_id: TRIAL_ID }), undefined)),
      `control item ${PROBE_PK}/config: trial_id present on a transport-probe configuration; expected none`,
    );
    assert.equal(
      refusal(decodeConfigItem(probeConfigItem({ trial_manifest_sha256: TRIAL_MANIFEST_SHA }), undefined)),
      `control item ${PROBE_PK}/config: trial_manifest_sha256 present on a transport-probe configuration; expected none`,
    );
  });

  it('refuses a malformed digest, caller, scenario or payment id', () => {
    const prefix = `control item ${TRIAL_PK}/config: `;
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL', { execution_manifest_sha256: 1 }), TRIAL_ID)),
      `${prefix}execution_manifest_sha256 number 1; expected 64 lowercase hex digits`,
    );
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL', { registered_caller_id: 'other' }), TRIAL_ID)),
      `${prefix}registered_caller_id string "other"; expected one of conventional, durable, probe`,
    );
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL', { scenario: 'control' }), TRIAL_ID)),
      `${prefix}scenario string "control"; expected one of CONTROL, COMMIT_THEN_TIMEOUT`,
    );
    assert.equal(
      refusal(decodeConfigItem(trialConfigItem('CONTROL', { payment_id: null }), TRIAL_ID)),
      `${prefix}payment_id null null; expected a string`,
    );
  });
});

describe('decodePaymentItem', () => {
  it('reads the payment id and currency', () => {
    assert.deepEqual(decodePaymentItem(paymentItem(TRIAL_PK)), {
      ok: true,
      value: { payment_id: PAYMENT_ID, currency: 'BRL' },
    });
    assert.equal(paymentSortKey('pay-poc-001'), 'payment#pay-poc-001');
  });

  it('refuses a payment whose id does not name its key, or a missing currency', () => {
    assert.equal(
      refusal(decodePaymentItem(paymentItem(TRIAL_PK, { payment_id: 'pay-other' }))),
      `control item ${TRIAL_PK}/payment#pay-poc-001: payment_id string "pay-other"; expected the string that names the item key`,
    );
    assert.equal(
      refusal(decodePaymentItem(paymentItem(TRIAL_PK, { payment_id: 5 }))),
      `control item ${TRIAL_PK}/payment#pay-poc-001: payment_id number 5; expected the string that names the item key`,
    );
    const { currency: _currency, ...withoutCurrency } = paymentItem(TRIAL_PK);
    assert.equal(
      refusal(decodePaymentItem(withoutCurrency as StoredItem)),
      `control item ${TRIAL_PK}/payment#pay-poc-001: currency absent; expected a string`,
    );
  });
});

describe('decodeTreatmentItem', () => {
  const base: StoredItem = { pk: TRIAL_PK, sk: 'treatment', state: 'ARMED', version: 1 };

  it('reads state, version, every identity and the safety-release cause', () => {
    assert.deepEqual(decodeTreatmentItem(base), { ok: true, value: { state: 'ARMED', version: 1 } });
    const full = {
      ...base,
      state: 'SAFETY_RELEASED',
      version: 4,
      targeted_attempt_id: SIGNAL_EVENT_ID,
      provider_request_id: SIGNAL_EVENT_ID,
      provider_call_id: SIGNAL_EVENT_ID,
      provider_commit_id: SIGNAL_EVENT_ID,
      provider_transaction_id: SIGNAL_EVENT_ID,
      commit_event_id: SIGNAL_EVENT_ID,
      signal_event_id: SIGNAL_EVENT_ID,
      signal_caller_event_id: SIGNAL_EVENT_ID,
      observed_event_id: SIGNAL_EVENT_ID,
      release_event_id: SIGNAL_EVENT_ID,
      safety_release_cause: 'CLEANUP_REQUEST',
      unrelated: 'ignored',
    };
    const { pk: _pk, sk: _sk, unrelated: _unrelated, ...expected } = full;
    assert.deepEqual(decodeTreatmentItem(full), { ok: true, value: expected });
  });

  it('refuses an unknown state, a non-positive or fractional version, a malformed id or cause', () => {
    const prefix = `control item ${TRIAL_PK}/treatment: `;
    assert.equal(
      refusal(decodeTreatmentItem({ ...base, state: 'armed' })),
      `${prefix}state string "armed"; expected one of ARMED, COMMITTED_WAITING, TIMEOUT_SIGNALLED, TIMEOUT_OBSERVED, RESPONSE_RELEASED, SAFETY_RELEASED`,
    );
    for (const version of [0, 1.5, '1']) {
      assert.match(refusal(decodeTreatmentItem({ ...base, version })), /version .*; expected a safe integer >= 1$/u);
    }
    assert.equal(
      refusal(decodeTreatmentItem({ ...base, signal_event_id: 'sig' })),
      `${prefix}signal_event_id string "sig"; expected a lowercase RFC 4122 version-4 UUID`,
    );
    assert.equal(
      refusal(decodeTreatmentItem({ ...base, safety_release_cause: 'TIMEOUT' })),
      `${prefix}safety_release_cause string "TIMEOUT"; expected one of SAFETY_DEADLINE, CLEANUP_REQUEST`,
    );
  });
});
