// AC-RUA-046 (group A) record contracts of the provider wire payloads: the refund call and its
// response (BR-RUA-018, INV-RUA-001) and the probe workload request (BR-RUA-027, D-06).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PROVIDER_CALLER_IDS } from '../../../../src/record-contract/records/group-a/provider_refund_call.ts';
import {
  PROVIDER_REFUND_OUTCOMES,
  PROVIDER_REJECTION_REASONS,
} from '../../../../src/record-contract/records/group-a/provider_refund_response.ts';
import {
  probeProviderRefundCall,
  probeWorkloadRequest,
  rejectedResponse,
  succeededResponse,
  trialProviderRefundCall,
} from './support/input-examples.ts';
import { IDS, uuid } from './support/sample-values.ts';
import { assertAccepted, assertRejected, withField, withoutField } from './support/validation-assertions.ts';

describe('provider_refund_call (BR-RUA-018)', () => {
  it('accepts trial calls from either variant and the probe call', () => {
    assertAccepted(trialProviderRefundCall(), 'conventional run call');
    assertAccepted(withField(trialProviderRefundCall(), 'caller_id', 'durable'), 'durable run call');
    assertAccepted(
      { ...withoutField(trialProviderRefundCall(), 'run_id'), variant_validation_id: IDS.variantValidation },
      'variant-validation call',
    );
    assertAccepted(probeProviderRefundCall(), 'probe call');
  });

  it('registers exactly the conventional, durable and probe callers', () => {
    assert.deepEqual(PROVIDER_CALLER_IDS, ['conventional', 'durable', 'probe']);
    assertRejected(withField(trialProviderRefundCall(), 'caller_id', 'agent'), '/caller_id enum', 'unknown caller');
  });

  it('scopes a variant call to its trial', () => {
    assertRejected(withoutField(trialProviderRefundCall(), 'trial_id'), ' required', 'missing trial id');
    assertRejected(withoutField(trialProviderRefundCall(), 'trial_manifest_sha256'), ' required', 'missing digest');
    assertRejected(
      withField(trialProviderRefundCall(), 'caller_id', 'probe'),
      '/caller_id enum',
      'probe caller in a run',
    );
  });

  it('gives a probe call no trial and only the probe caller (D-06)', () => {
    assertRejected(withField(probeProviderRefundCall(), 'trial_id', IDS.trial1), '/trial_id false schema', 'trial id');
    assertRejected(
      withField(probeProviderRefundCall(), 'trial_manifest_sha256', 'b'.repeat(64)),
      '/trial_manifest_sha256 false schema',
      'trial digest',
    );
    assertRejected(
      withField(probeProviderRefundCall(), 'caller_id', 'conventional'),
      '/caller_id const',
      'variant caller',
    );
  });

  it('names exactly one execution identity with its manifest digest', () => {
    assertRejected(withField(trialProviderRefundCall(), 'transport_probe_id', IDS.transportProbe), ' oneOf', 'two');
    assertRejected(withoutField(probeProviderRefundCall(), 'transport_probe_id'), ' oneOf', 'none');
    assertRejected(withoutField(trialProviderRefundCall(), 'execution_manifest_sha256'), ' required', 'no digest');
  });

  it('carries the physical identities of INV-RUA-001 as lowercase UUIDv4', () => {
    assertAccepted(withField(trialProviderRefundCall(), 'attempt_id', uuid(0xabcdef)), 'lowercase hex letters');
    assertRejected(
      withField(trialProviderRefundCall(), 'attempt_id', uuid(0xabcdef).toUpperCase()),
      '/attempt_id pattern',
      'case',
    );
    const version1 = '00000000-0000-1000-8000-000000000301';
    assertRejected(withField(trialProviderRefundCall(), 'attempt_id', version1), '/attempt_id pattern', 'version 1');
    assertRejected(withoutField(trialProviderRefundCall(), 'provider_request_id'), ' required', 'missing request id');
    assertRejected(
      withField(trialProviderRefundCall(), 'provider_call_id', IDS.providerCall),
      ' additionalProperties',
      'call id is provider-generated',
    );
  });

  it('leaves currency mismatch to the provider and accepts no idempotency key', () => {
    assertAccepted(withField(trialProviderRefundCall(), 'currency', 'USD'), 'a well-formed foreign currency');
    for (const value of ['brl', 'BRLX', 'R$', '']) {
      assertRejected(withField(trialProviderRefundCall(), 'currency', value), '/currency pattern', value);
    }
    assertRejected(withField(trialProviderRefundCall(), 'amount_minor', -1), '/amount_minor minimum', 'negative');
    assertRejected(
      withField(trialProviderRefundCall(), 'idempotency_key', IDS.attempt),
      ' additionalProperties',
      'idempotency',
    );
  });
});

describe('provider_refund_response (BR-RUA-018)', () => {
  it('accepts a success and a rejection', () => {
    assertAccepted(succeededResponse(), 'succeeded');
    assertAccepted(rejectedResponse(), 'rejected');
    assert.deepEqual(PROVIDER_REFUND_OUTCOMES, ['SUCCEEDED', 'REJECTED']);
    assertRejected(withField(succeededResponse(), 'outcome', 'TIMED_OUT'), '/outcome enum', 'timeouts are caller-side');
  });

  it('always names the provider-generated call identity', () => {
    assertRejected(withoutField(succeededResponse(), 'provider_call_id'), ' required', 'succeeded');
    assertRejected(withoutField(rejectedResponse(), 'provider_call_id'), ' required', 'rejected');
  });

  it('echoes the caller identities and names the transaction on success', () => {
    for (const field of ['attempt_id', 'provider_request_id', 'provider_transaction_id']) {
      assertRejected(withoutField(succeededResponse(), field), ' required', `missing ${field}`);
    }
    assertRejected(
      withField(succeededResponse(), 'rejection_reason', 'AMOUNT_INVALID'),
      '/rejection_reason false schema',
      'reason',
    );
  });

  it('names the failed acceptance condition and no transaction on rejection', () => {
    assert.deepEqual(PROVIDER_REJECTION_REASONS, [
      'AUTHORIZATION_FAILED',
      'SCHEMA_INVALID',
      'EXECUTION_IDENTITY_MISMATCH',
      'IDENTITY_STRUCTURE_INVALID',
      'PAYMENT_NOT_FOUND',
      'AMOUNT_INVALID',
      'CURRENCY_MISMATCH',
    ]);
    for (const reason of PROVIDER_REJECTION_REASONS) {
      assertAccepted(withField(rejectedResponse(), 'rejection_reason', reason), reason);
    }
    assertRejected(
      withField(rejectedResponse(), 'rejection_reason', 'DUPLICATE_REQUEST'),
      '/rejection_reason enum',
      'no dedup',
    );
    assertRejected(withoutField(rejectedResponse(), 'rejection_reason'), ' required', 'missing reason');
    assertRejected(
      withField(rejectedResponse(), 'provider_transaction_id', IDS.providerTransaction),
      '/provider_transaction_id false schema',
      'a rejected call creates no transaction',
    );
  });
});

describe('probe_workload_request (BR-RUA-027)', () => {
  it('accepts the canonical probe workload request', () => {
    assertAccepted(probeWorkloadRequest(), 'canonical');
  });

  it('is identified by the probe, never by a run or trial (D-06)', () => {
    assertRejected(withField(probeWorkloadRequest(), 'trial_id', IDS.trial1), ' additionalProperties', 'trial id');
    assertRejected(
      { ...withoutField(probeWorkloadRequest(), 'transport_probe_id'), run_id: IDS.run },
      ' required',
      'run identity',
    );
    assertRejected(withoutField(probeWorkloadRequest(), 'execution_manifest_sha256'), ' required', 'no digest');
  });

  it('requests the declared BRL effect', () => {
    assertRejected(withField(probeWorkloadRequest(), 'currency', 'USD'), '/currency const', 'currency');
    assertRejected(withField(probeWorkloadRequest(), 'amount_minor', 0), '/amount_minor minimum', 'zero amount');
    assertRejected(withField(probeWorkloadRequest(), 'refund_request_id', ''), '/refund_request_id pattern', 'blank');
  });
});
