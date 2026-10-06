// Steps A3 and A4 (BR-RUA-017, BR-RUA-038, D-31, CTR-RUA-005, CTR-RUA-006): the OR-RUA-001 records
// are admitted; every financial problem is named by its own code, in record order; identifiers
// must be nonempty after trimming with no surrounding whitespace; and the request names a
// variant exactly when it is a variant validation.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assessFinancialInput,
  assessIdentityInput,
  validateFinancialInput,
  validateIdentityInput,
} from '../../../src/admission/financial-input.ts';
import type { FinancialInputObjects } from '../../../src/admission/financial-input.ts';
import { OR_RUA_001_APPROVED_DECISION, OR_RUA_001_PAYMENT } from '../../../src/admission/declared-inputs.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { parsedJson, parsedTower } from '../../support/kernel/deep-json.ts';

function codes(payment: JsonValue, decision: JsonValue): readonly string[] {
  return validateFinancialInput(payment, decision).map((reason) => reason.code);
}

const payment = (members: Readonly<Record<string, JsonValue>> = {}): JsonObject => ({
  ...OR_RUA_001_PAYMENT,
  ...members,
});
const decision = (members: Readonly<Record<string, JsonValue>> = {}): JsonObject => ({
  ...OR_RUA_001_APPROVED_DECISION,
  ...members,
});
const OBJECTS: FinancialInputObjects = { payment: payment(), decision: decision() };

describe('validateFinancialInput (A3)', () => {
  it('admits the OR-RUA-001 records', () => {
    assert.deepEqual(validateFinancialInput(payment(), decision()), []);
  });

  it('refuses records that are not objects, describing both', () => {
    assert.deepEqual(validateFinancialInput([1], null), [
      {
        code: 'FINANCIAL_RECORD_NOT_OBJECT',
        subject: 'BR-RUA-017',
        detail: 'payment is array [1] and approved decision is null null; expected two JSON objects',
      },
    ]);
    assert.deepEqual(codes(payment(), 'x'), ['FINANCIAL_RECORD_NOT_OBJECT']);
  });

  it('refuses a wrong schema version or record type and an unknown member', () => {
    assert.deepEqual(codes(payment({ schema_version: 2 }), decision({ record_type: 'payment' })), [
      'FINANCIAL_RECORD_TYPE_INVALID',
      'FINANCIAL_RECORD_TYPE_INVALID',
    ]);
    const unknown = validateFinancialInput(payment({ card_number: '4111' }), decision());
    assert.deepEqual(
      unknown.map((reason) => reason.code),
      ['FINANCIAL_RECORD_MEMBER_UNKNOWN'],
    );
    assert.match(
      unknown[0]?.detail ?? '',
      /^payment has member "card_number"; expected only schema_version, record_type/,
    );
    assert.deepEqual(codes(payment(), decision({ note: 'x' })), ['FINANCIAL_RECORD_MEMBER_UNKNOWN']);
  });

  it('D-31: refuses unequal captured and approved amounts', () => {
    const reasons = validateFinancialInput(payment(), decision({ approved_amount_minor: 9000 }));
    assert.deepEqual(reasons, [
      {
        code: 'AMOUNTS_UNEQUAL',
        subject: 'BR-RUA-017',
        detail:
          'captured_amount_minor number 10000 and approved_amount_minor number 9000 differ; expected equal amounts, because only full refunds are supported',
      },
    ]);
  });

  it('refuses zero, negative, fractional, missing and non-number amounts', () => {
    for (const amount of [0, -1, 1.5, '10000', null]) {
      assert.deepEqual(codes(payment({ captured_amount_minor: amount }), decision()), ['AMOUNT_NOT_POSITIVE_INTEGER']);
    }
    const { captured_amount_minor: _captured, ...missing } = OR_RUA_001_PAYMENT;
    assert.deepEqual(codes(missing, decision()), ['AMOUNT_NOT_POSITIVE_INTEGER']);
  });

  it('refuses amounts beyond 9007199254740991', () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const reasons = validateFinancialInput(
      payment({ captured_amount_minor: unsafe }),
      decision({ approved_amount_minor: unsafe }),
    );
    assert.deepEqual(
      reasons.map((reason) => reason.code),
      ['AMOUNT_UNSAFE', 'AMOUNT_UNSAFE'],
    );
    assert.match(reasons[0]?.detail ?? '', /expected at most 9007199254740991$/);
    assert.deepEqual(
      codes(
        payment({ captured_amount_minor: Number.MAX_SAFE_INTEGER }),
        decision({ approved_amount_minor: Number.MAX_SAFE_INTEGER }),
      ),
      [],
    );
  });

  it('refuses a non-BRL currency in either record and a mismatch between them', () => {
    assert.deepEqual(codes(payment({ currency: 'USD' }), decision({ currency: 'USD' })), [
      'CURRENCY_NOT_BRL',
      'CURRENCY_NOT_BRL',
    ]);
    assert.deepEqual(codes(payment(), decision({ currency: 'brl' })), ['CURRENCY_NOT_BRL', 'CURRENCY_MISMATCH']);
  });

  it('refuses a decision other than APPROVED', () => {
    assert.deepEqual(codes(payment(), decision({ decision: 'REJECTED' })), ['DECISION_NOT_APPROVED']);
  });

  it('refuses a decision that names another payment, but leaves a non-string id to A4', () => {
    assert.deepEqual(codes(payment(), decision({ payment_id: 'pay-poc-002' })), ['PAYMENT_ID_MISMATCH']);
    assert.deepEqual(codes(payment({ payment_id: 7 }), decision()), []);
    assert.deepEqual(codes(payment(), decision({ payment_id: 7 })), []);
  });

  it('reads only own members', () => {
    const inherited = Object.create({ captured_amount_minor: 10000 }) as JsonObject;
    Object.assign(inherited, { schema_version: 1, record_type: 'payment', payment_id: 'pay-poc-001', currency: 'BRL' });
    assert.deepEqual(codes(inherited, decision()), ['AMOUNT_NOT_POSITIVE_INTEGER']);
  });
});

describe('assessFinancialInput (A3)', () => {
  it('passes with the two objects', () => {
    const verdict = assessFinancialInput({ payment: payment(), approved_decision: decision() });
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value, OBJECTS);
  });

  it('fails as FINANCIAL_INPUT', () => {
    const verdict = assessFinancialInput({ payment: payment(), approved_decision: decision({ currency: 'EUR' }) });
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'FINANCIAL_INPUT');
    const notObjects = assessFinancialInput({ payment: 'p', approved_decision: decision() });
    assert.ok(!notObjects.passed);
    assert.deepEqual(
      notObjects.reasons.map((reason) => reason.code),
      ['FINANCIAL_RECORD_NOT_OBJECT'],
    );
  });
});

describe('validateIdentityInput and assessIdentityInput (A4)', () => {
  it('admits the OR-RUA-001 identifiers and declares the inputs and the target', () => {
    assert.deepEqual(validateIdentityInput(payment(), decision()), []);
    const verdict = assessIdentityInput(OBJECTS, 'RUN', undefined);
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value, {
      financial_inputs: {
        currency: 'BRL',
        payment_id: 'pay-poc-001',
        captured_amount_minor: 10000,
        refund_request_id: 'ref-poc-001',
        approved_amount_minor: 10000,
        decision: 'APPROVED',
      },
      target: { kind: 'RUN' },
    });
  });

  it('refuses empty, padded and non-string identifiers', () => {
    const reasons = validateIdentityInput(
      payment({ payment_id: '  ' }),
      decision({ refund_request_id: ' ref', payment_id: 3 }),
    );
    assert.deepEqual(
      reasons.map((reason) => reason.detail.slice(0, reason.detail.indexOf(' is '))),
      ['payment.payment_id', 'approved_decision.refund_request_id', 'approved_decision.payment_id'],
    );
    assert.ok(reasons.every((reason) => reason.code === 'IDENTIFIER_EMPTY'));
    const verdict = assessIdentityInput(
      { payment: payment({ payment_id: 3 }), decision: decision() },
      'TRANSPORT_PROBE',
      undefined,
    );
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'IDENTITY');
  });

  it('a validation names exactly one known variant', () => {
    const durable = assessIdentityInput(OBJECTS, 'VARIANT_VALIDATION', 'durable');
    assert.ok(durable.passed);
    assert.deepEqual(durable.value.target, { kind: 'VARIANT_VALIDATION', variant: 'durable' });
    const described = new Map<JsonValue | undefined, string>([
      [undefined, 'absent'],
      ['hybrid', 'string "hybrid"'],
      [1, 'number 1'],
    ]);
    for (const [variant, text] of described) {
      const verdict = assessIdentityInput(OBJECTS, 'VARIANT_VALIDATION', variant);
      assert.ok(!verdict.passed);
      assert.deepEqual(verdict.reasons[0], {
        code: 'EXECUTION_VARIANT_INVALID',
        subject: 'BR-RUA-038',
        detail: `a VARIANT_VALIDATION request names variant ${text}; expected "conventional" or "durable"`,
      });
    }
  });

  it('a run or a probe names no variant', () => {
    const verdict = assessIdentityInput(OBJECTS, 'TRANSPORT_PROBE', 'durable');
    assert.ok(!verdict.passed);
    assert.equal(verdict.reasons[0].code, 'EXECUTION_VARIANT_INVALID');
    assert.match(verdict.reasons[0].detail, /expected no variant$/);
    const probe = assessIdentityInput(OBJECTS, 'TRANSPORT_PROBE', undefined);
    assert.ok(probe.passed);
    assert.deepEqual(probe.value.target, { kind: 'TRANSPORT_PROBE' });
  });

  it('A-05: stays total when amounts A3 would refuse reach it, never coercing them', () => {
    // Regression (WP-23 review): `Number(...)` on a parsed `{"toString":1,"valueOf":1}` threw
    // TypeError "Cannot convert object to primitive value" out of the step.
    const hostile = [
      parsedJson('{"toString":1,"valueOf":1}'),
      parsedJson('[{"valueOf":1}]'),
      parsedJson('"10000"'),
      parsedTower('mixed'),
    ];
    for (const amount of hostile) {
      const objects = {
        payment: payment({ captured_amount_minor: amount }),
        decision: decision({ approved_amount_minor: amount }),
      };
      const verdict = assessIdentityInput(objects, 'RUN', undefined);
      assert.ok(verdict.passed, 'A4 judges identifiers only');
      assert.ok(Number.isNaN(verdict.value.financial_inputs.captured_amount_minor));
      assert.ok(Number.isNaN(verdict.value.financial_inputs.approved_amount_minor));
    }
  });
});
