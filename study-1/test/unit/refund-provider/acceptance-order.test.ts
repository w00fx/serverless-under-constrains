// `evaluateAcceptance` as a pure function (BR-RUA-018, design §9.10): the checks run in the
// declared order, so a call failing several conditions is rejected for the first; an accepted
// call carries exactly the checked fields; the provider never consults an approved decision.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AcceptanceContext } from '../../../src/refund-provider/acceptance.ts';
import { evaluateAcceptance } from '../../../src/refund-provider/acceptance.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  ATTEMPT_ID,
  MANIFEST_SHA,
  OTHER_RUN_ID,
  OTHER_SHA,
  OTHER_TRIAL_ID,
  PAYMENT_ID,
  PROBE,
  PROBE_ID,
  PROVIDER_REQUEST_ID,
  REFUND_REQUEST_ID,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  validCall,
  validProbeCall,
} from './support/provider-fixtures.ts';

const TRIAL_CONTEXT: AcceptanceContext = {
  deployment_execution: RUN,
  trial_configuration: {
    execution_manifest_sha256: MANIFEST_SHA,
    registered_caller_id: 'conventional',
    scenario: 'COMMIT_THEN_TIMEOUT',
    payment_id: PAYMENT_ID,
    trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
  },
  payment: { payment_id: PAYMENT_ID, currency: 'BRL' },
};

const PROBE_CONTEXT: AcceptanceContext = {
  deployment_execution: PROBE,
  trial_configuration: {
    execution_manifest_sha256: MANIFEST_SHA,
    registered_caller_id: 'probe',
    scenario: 'COMMIT_THEN_TIMEOUT',
    payment_id: PAYMENT_ID,
  },
  payment: { payment_id: PAYMENT_ID, currency: 'BRL' },
};

function rejection(raw: JsonValue, ctx: AcceptanceContext = TRIAL_CONTEXT): readonly [string, string] {
  const decision = evaluateAcceptance(raw, ctx);
  assert.equal(decision.accepted, false, `expected ${JSON.stringify(raw)} to be rejected`);
  return [decision.reason, decision.detail];
}

describe('evaluateAcceptance', () => {
  it('accepts a valid trial call with exactly the checked fields', () => {
    assert.deepEqual(evaluateAcceptance(validCall(), TRIAL_CONTEXT), {
      accepted: true,
      call: {
        caller_id: 'conventional',
        attempt_id: ATTEMPT_ID,
        provider_request_id: PROVIDER_REQUEST_ID,
        refund_request_id: REFUND_REQUEST_ID,
        payment_id: PAYMENT_ID,
        amount_minor: 10000,
        currency: 'BRL',
      },
    });
  });

  it('accepts a valid probe call in the probe deployment', () => {
    const decision = evaluateAcceptance(validProbeCall(), PROBE_CONTEXT);
    assert.equal(decision.accepted && decision.call.caller_id, 'probe');
  });

  it('accepts any positive amount: the provider never compares it with an approved refund', () => {
    for (const amount of [1, 20000, Number.MAX_SAFE_INTEGER]) {
      assert.equal(evaluateAcceptance(validCall({ amount_minor: amount }), TRIAL_CONTEXT).accepted, true);
    }
    assert.equal(evaluateAcceptance(validCall({ refund_request_id: 'ref-poc-002' }), TRIAL_CONTEXT).accepted, true);
  });

  it('checks authorization first, against the registered caller', () => {
    assert.deepEqual(rejection(validCall({ caller_id: 'durable', amount_minor: 0 })), [
      'AUTHORIZATION_FAILED',
      'caller_id string "durable"; expected the registered caller "conventional"',
    ]);
    assert.deepEqual(rejection([]), [
      'AUTHORIZATION_FAILED',
      'caller_id absent; expected the registered caller "conventional"',
    ]);
  });

  it('checks the schema before the execution identity', () => {
    const [reason, detail] = rejection(validCall({ run_id: OTHER_RUN_ID, extra: true }));
    assert.equal(reason, 'SCHEMA_INVALID');
    assert.match(detail, /^property "extra" is not part of provider_refund_call/u);
  });

  it('checks the execution identity, the manifest digest and the trial before identity structure', () => {
    assert.deepEqual(rejection(validCall({ run_id: OTHER_RUN_ID, attempt_id: 'x' })), [
      'EXECUTION_IDENTITY_MISMATCH',
      `execution RUN ${OTHER_RUN_ID}; expected the active execution RUN ${RUN_ID}`,
    ]);
    assert.deepEqual(rejection(validCall({ execution_manifest_sha256: OTHER_SHA })), [
      'EXECUTION_IDENTITY_MISMATCH',
      `execution_manifest_sha256 ${OTHER_SHA}; expected the frozen manifest ${MANIFEST_SHA}`,
    ]);
    assert.deepEqual(rejection(validCall({ trial_id: OTHER_TRIAL_ID })), [
      'EXECUTION_IDENTITY_MISMATCH',
      `trial ${OTHER_TRIAL_ID} (manifest ${TRIAL_MANIFEST_SHA}); expected the configured trial ${TRIAL_ID} (manifest ${TRIAL_MANIFEST_SHA})`,
    ]);
    assert.deepEqual(rejection(validCall({ trial_manifest_sha256: OTHER_SHA })), [
      'EXECUTION_IDENTITY_MISMATCH',
      `trial ${TRIAL_ID} (manifest ${OTHER_SHA}); expected the configured trial ${TRIAL_ID} (manifest ${TRIAL_MANIFEST_SHA})`,
    ]);
  });

  it('rejects a run call in a probe deployment and a probe call in a run deployment', () => {
    const probeConfigured = {
      ...PROBE_CONTEXT,
      trial_configuration: { ...PROBE_CONTEXT.trial_configuration, registered_caller_id: 'conventional' as const },
    };
    assert.deepEqual(rejection(validCall(), probeConfigured), [
      'EXECUTION_IDENTITY_MISMATCH',
      `execution RUN ${RUN_ID}; expected the active execution TRANSPORT_PROBE ${PROBE_ID}`,
    ]);
    const sameIdProbe = {
      ...PROBE_CONTEXT,
      deployment_execution: { execution_kind: 'TRANSPORT_PROBE' as const, transport_probe_id: RUN_ID },
    };
    assert.equal(
      rejection(validCall(), { ...sameIdProbe, trial_configuration: probeConfigured.trial_configuration })[0],
      'EXECUTION_IDENTITY_MISMATCH',
    );
    const runConfiguredForProbe = {
      ...TRIAL_CONTEXT,
      trial_configuration: { ...TRIAL_CONTEXT.trial_configuration, registered_caller_id: 'probe' as const },
    };
    assert.deepEqual(rejection(validProbeCall(), runConfiguredForProbe)[0], 'EXECUTION_IDENTITY_MISMATCH');
  });

  it('rejects a probe-shaped call whose configuration names a trial', () => {
    const configuredTrial = {
      ...PROBE_CONTEXT,
      trial_configuration: {
        ...PROBE_CONTEXT.trial_configuration,
        trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
      },
    };
    assert.deepEqual(rejection(validProbeCall(), configuredTrial), [
      'EXECUTION_IDENTITY_MISMATCH',
      `trial none; expected the configured trial ${TRIAL_ID} (manifest ${TRIAL_MANIFEST_SHA})`,
    ]);
  });

  it('checks identity structure before the payment', () => {
    assert.deepEqual(rejection(validCall({ payment_id: ' ', amount_minor: 0 })), [
      'IDENTITY_STRUCTURE_INVALID',
      'payment_id " "; expected a string that is non-empty after trimming',
    ]);
  });

  it('checks the payment before the amount, and the amount before the currency', () => {
    assert.deepEqual(rejection(validCall({ payment_id: 'pay-x', amount_minor: 0 })), [
      'PAYMENT_NOT_FOUND',
      'payment_id "pay-x"; expected a payment that exists in the trial partition',
    ]);
    assert.deepEqual(rejection(validCall(), { ...TRIAL_CONTEXT, payment: undefined }), [
      'PAYMENT_NOT_FOUND',
      `payment_id "${PAYMENT_ID}"; expected a payment that exists in the trial partition`,
    ]);
    assert.deepEqual(rejection(validCall({ amount_minor: 0, currency: 'USD' })), [
      'AMOUNT_INVALID',
      'amount_minor 0; expected a safe integer >= 1 (at most 9007199254740991)',
    ]);
    assert.deepEqual(rejection(validCall({ currency: 'USD' })), [
      'CURRENCY_MISMATCH',
      'currency "USD"; expected the payment currency "BRL"',
    ]);
  });
});
