// The hand-written `provider_refund_call` guard (design §9.10 checks 2, 4 and 6): each schema
// rule is refused with a detail that names the offending value and the expected shape, and a
// valid trial or probe call is read into its typed shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { RefundCallShape } from '../../../src/refund-provider/refund-call-shape.ts';
import {
  amountViolation,
  guardRefundCallShape,
  identityStructureViolation,
  REFUND_CALL_PROPERTIES,
} from '../../../src/refund-provider/refund-call-shape.ts';
import {
  ATTEMPT_ID,
  MANIFEST_SHA,
  PAYMENT_ID,
  PROBE_ID,
  PROVIDER_REQUEST_ID,
  REFUND_REQUEST_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  validCall,
  validProbeCall,
  withoutProperty,
} from './support/provider-fixtures.ts';

function problemOf(raw: JsonValue): string {
  const result = guardRefundCallShape(raw);
  assert.equal(result.ok, false, `expected ${JSON.stringify(raw)} to be refused`);
  return result.error;
}

const TRIAL_SHAPE: RefundCallShape = {
  caller_id: 'conventional',
  execution: { execution_kind: 'RUN', run_id: RUN_ID },
  execution_manifest_sha256: MANIFEST_SHA,
  trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
  attempt_id: ATTEMPT_ID,
  provider_request_id: PROVIDER_REQUEST_ID,
  refund_request_id: REFUND_REQUEST_ID,
  payment_id: PAYMENT_ID,
  amount_minor: 10000,
  currency: 'BRL',
};

describe('guardRefundCallShape', () => {
  it('reads a valid trial call and a valid probe call into their shapes', () => {
    assert.deepEqual(guardRefundCallShape(validCall()), { ok: true, value: TRIAL_SHAPE });
    const { trial: _trial, ...probeFields } = TRIAL_SHAPE;
    assert.deepEqual(guardRefundCallShape(validProbeCall()), {
      ok: true,
      value: {
        ...probeFields,
        caller_id: 'probe',
        execution: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID },
      },
    });
    const durable = guardRefundCallShape(validCall({ caller_id: 'durable', run_id: RUN_ID }));
    assert.equal(durable.ok && durable.value.caller_id, 'durable');
  });

  it('refuses a payload that is not a JSON object', () => {
    assert.equal(problemOf([]), 'call is array []; expected a provider_refund_call JSON object');
    assert.equal(problemOf(null), 'call is null null; expected a provider_refund_call JSON object');
    assert.equal(problemOf('call'), 'call is string "call"; expected a provider_refund_call JSON object');
  });

  it('refuses a property outside the closed property set', () => {
    assert.equal(
      problemOf(validCall({ evidence: 1 })),
      `property "evidence" is not part of provider_refund_call; expected only ${REFUND_CALL_PROPERTIES.join(', ')}`,
    );
    assert.equal(REFUND_CALL_PROPERTIES.length, 15);
  });

  it('refuses a wrong schema_version, record_type, caller_id or manifest digest', () => {
    assert.equal(problemOf(validCall({ schema_version: 2 })), 'schema_version is number 2; expected the number 1');
    assert.equal(
      problemOf(withoutProperty(validCall(), 'schema_version')),
      'schema_version is absent; expected the number 1',
    );
    assert.equal(
      problemOf(validCall({ record_type: 'payment' })),
      'record_type is string "payment"; expected "provider_refund_call"',
    );
    assert.equal(
      problemOf(validCall({ caller_id: 'Conventional' })),
      'caller_id is string "Conventional"; expected one of conventional, durable, probe',
    );
    assert.equal(
      problemOf(withoutProperty(validCall(), 'caller_id')),
      'caller_id is absent; expected one of conventional, durable, probe',
    );
    assert.equal(
      problemOf(validCall({ execution_manifest_sha256: 'A'.repeat(64) })),
      `execution_manifest_sha256 is string "${'A'.repeat(64)}"; expected 64 lowercase hex digits`,
    );
  });

  it('refuses a missing or non-string identity field', () => {
    for (const fieldName of ['attempt_id', 'provider_request_id', 'refund_request_id', 'payment_id']) {
      assert.equal(problemOf(withoutProperty(validCall(), fieldName)), `${fieldName} is absent; expected a string`);
    }
    assert.equal(problemOf(validCall({ payment_id: 7 })), 'payment_id is number 7; expected a string');
  });

  it('refuses a non-number amount and a malformed currency', () => {
    assert.equal(
      problemOf(validCall({ amount_minor: '10000' })),
      'amount_minor is string "10000"; expected a JSON number',
    );
    assert.equal(
      problemOf(withoutProperty(validCall(), 'amount_minor')),
      'amount_minor is absent; expected a JSON number',
    );
    assert.equal(
      problemOf(validCall({ currency: 'brl' })),
      'currency is string "brl"; expected three uppercase ASCII letters',
    );
    assert.equal(
      problemOf(validCall({ currency: 'BRLX' })),
      'currency is string "BRLX"; expected three uppercase ASCII letters',
    );
    assert.equal(
      problemOf(validCall({ currency: 986 })),
      'currency is number 986; expected three uppercase ASCII letters',
    );
  });

  it('requires exactly one well-formed execution identity', () => {
    assert.equal(
      problemOf(withoutProperty(validCall(), 'run_id')),
      'execution identity fields []; expected exactly one of run_id, variant_validation_id, transport_probe_id',
    );
    assert.equal(
      problemOf(validCall({ transport_probe_id: PROBE_ID })),
      'execution identity fields [run_id, transport_probe_id]; expected exactly one of run_id, variant_validation_id, transport_probe_id',
    );
    assert.equal(
      problemOf(validCall({ run_id: 'run-1' })),
      'run_id is string "run-1"; expected a lowercase RFC 4122 version-4 UUID',
    );
  });

  it('enforces the trial branch: a variant caller and both trial fields', () => {
    assert.equal(
      problemOf(validCall({ caller_id: 'probe' })),
      'caller_id "probe" on a RUN call; expected conventional or durable',
    );
    assert.equal(
      problemOf(withoutProperty(validCall(), 'trial_id')),
      'trial_id is absent; expected a lowercase RFC 4122 version-4 UUID',
    );
    assert.equal(
      problemOf(validCall({ trial_manifest_sha256: 'b'.repeat(63) })),
      `trial_manifest_sha256 is string "${'b'.repeat(63)}"; expected 64 lowercase hex digits`,
    );
  });

  it('enforces the probe branch: the probe caller and no trial identity (D-06)', () => {
    assert.equal(
      problemOf(validProbeCall({ caller_id: 'durable' })),
      'caller_id is string "durable" on a transport-probe call; expected "probe"',
    );
    assert.equal(
      problemOf(validProbeCall({ trial_id: TRIAL_ID })),
      'trial_id is present on a transport-probe call; expected no trial identity (D-06)',
    );
    assert.equal(
      problemOf(validProbeCall({ trial_manifest_sha256: TRIAL_MANIFEST_SHA })),
      'trial_manifest_sha256 is present on a transport-probe call; expected no trial identity (D-06)',
    );
  });
});

describe('identityStructureViolation (check 4)', () => {
  it('accepts lowercase UUIDv4 attempt identities and trimmed business identities', () => {
    assert.equal(identityStructureViolation(TRIAL_SHAPE), undefined);
    assert.equal(identityStructureViolation({ ...TRIAL_SHAPE, refund_request_id: 'r', payment_id: 'a b' }), undefined);
  });

  it('names the first malformed identity', () => {
    assert.equal(
      identityStructureViolation({ ...TRIAL_SHAPE, attempt_id: 'X' }),
      'attempt_id "X"; expected a lowercase RFC 4122 version-4 UUID',
    );
    assert.equal(
      identityStructureViolation({ ...TRIAL_SHAPE, provider_request_id: ATTEMPT_ID.toUpperCase() }),
      `provider_request_id "${ATTEMPT_ID.toUpperCase()}"; expected a lowercase RFC 4122 version-4 UUID`,
    );
    assert.equal(
      identityStructureViolation({ ...TRIAL_SHAPE, refund_request_id: 'ref ' }),
      'refund_request_id "ref "; expected a string that is non-empty after trimming',
    );
    assert.equal(
      identityStructureViolation({ ...TRIAL_SHAPE, payment_id: '' }),
      'payment_id ""; expected a string that is non-empty after trimming',
    );
    assert.equal(
      identityStructureViolation({ ...TRIAL_SHAPE, payment_id: 'pay\npoc' }),
      'payment_id "pay\\npoc"; expected a string that is non-empty after trimming',
    );
  });
});

describe('amountViolation (check 6)', () => {
  it('accepts every safe integer from 1 to 2^53 - 1', () => {
    assert.equal(amountViolation({ ...TRIAL_SHAPE, amount_minor: 1 }), undefined);
    assert.equal(amountViolation({ ...TRIAL_SHAPE, amount_minor: Number.MAX_SAFE_INTEGER }), undefined);
  });

  it('refuses zero, negatives, fractions and unsafe integers', () => {
    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(
        amountViolation({ ...TRIAL_SHAPE, amount_minor: amount }),
        `amount_minor ${String(amount)}; expected a safe integer >= 1 (at most 9007199254740991)`,
      );
    }
  });
});
