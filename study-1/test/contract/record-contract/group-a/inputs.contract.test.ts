// AC-RUA-046 (group A) record contracts of the trial inputs: environment input (BR-RUA-041),
// payment (CTR-RUA-005), approved decision (CTR-RUA-006) and the published trial message
// (BR-RUA-036). Each case starts from a valid record and changes exactly one thing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseJsonDocument } from '../../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import { inVariantValidation } from './support/branch-examples.ts';
import { approvedDecision, environmentInput, payment, trialMessage } from './support/input-examples.ts';
import { IDS } from './support/sample-values.ts';
import { assertAccepted, assertRejected, withField, withPath, withoutField } from './support/validation-assertions.ts';

function specExample(text: string): JsonValue {
  const parsed = parseJsonDocument(new TextEncoder().encode(text));
  assert.ok(parsed.ok, `the spec example ${text} is JSON`);
  return parsed.value;
}

describe('environment_input (BR-RUA-041)', () => {
  it('accepts the canonical environment input', () => {
    assertAccepted(environmentInput(), 'canonical');
  });

  it('holds exactly one 12-digit account in the allowlist', () => {
    assertRejected(withField(environmentInput(), 'account_allowlist', []), '/account_allowlist minItems', 'empty');
    assertRejected(
      withField(environmentInput(), 'account_allowlist', ['012345678901', '109876543210']),
      '/account_allowlist maxItems',
      'two accounts',
    );
    assertRejected(
      withPath(environmentInput(), ['account_allowlist', 0], '12345678901'),
      '/account_allowlist/0 pattern',
      '11 digits',
    );
    assertRejected(
      withPath(environmentInput(), ['account_allowlist', 0], 12345678901),
      '/account_allowlist/0 type',
      'number',
    );
  });

  it('carries no credentials, tokens, passwords or credential-process commands', () => {
    for (const field of [
      'aws_access_key_id',
      'aws_secret_access_key',
      'aws_session_token',
      'password',
      'credential_process',
    ]) {
      assertRejected(withField(environmentInput(), field, 'secret'), ' additionalProperties', field);
    }
  });

  it('identifies the coordination resource by ARN, stack id and schema version', () => {
    assertRejected(
      withField(environmentInput(), 'coordination_table_arn', 'suc-study-1-coordination'),
      '/coordination_table_arn pattern',
      'bare name',
    );
    assertRejected(
      withField(environmentInput(), 'coordination_stack_id', 'suc-study-1-coordination'),
      '/coordination_stack_id pattern',
      'stack name',
    );
    assertRejected(
      withField(environmentInput(), 'expected_coordination_schema_version', 0),
      '/expected_coordination_schema_version minimum',
      'zero',
    );
    assertRejected(
      withField(environmentInput(), 'expected_coordination_schema_version', '1'),
      '/expected_coordination_schema_version type',
      'string',
    );
    assertRejected(withoutField(environmentInput(), 'coordination_stack_id'), ' required', 'missing stack id');
  });
});

describe('payment (CTR-RUA-005)', () => {
  it('accepts the CTR-RUA-005 example verbatim', () => {
    assertAccepted(
      specExample(
        '{"schema_version":1,"record_type":"payment","payment_id":"pay-poc-001","captured_amount_minor":10000,"currency":"BRL"}',
      ) as object,
      'CTR-RUA-005',
    );
    assertAccepted(payment(), 'typed canonical');
  });

  it('is a captured BRL amount and nothing else', () => {
    assertRejected(withField(payment(), 'currency', 'USD'), '/currency const', 'non-BRL');
    assertRejected(withField(payment(), 'refunded_total_minor', '0'), ' additionalProperties', 'extra field');
    assertRejected(withoutField(payment(), 'captured_amount_minor'), ' required', 'missing amount');
  });

  it('requires an identifier that is non-empty after trimming', () => {
    for (const value of ['', ' ', ' pay-poc-001', 'pay-poc-001 ', '\tpay-poc-001']) {
      assertRejected(withField(payment(), 'payment_id', value), '/payment_id pattern', JSON.stringify(value));
    }
    assertAccepted(withField(payment(), 'payment_id', 'pay poc 001'), 'inner whitespace is kept');
  });
});

describe('approved_decision (CTR-RUA-006)', () => {
  it('accepts the CTR-RUA-006 example verbatim', () => {
    assertAccepted(
      specExample(
        '{"schema_version":1,"record_type":"approved_decision","refund_request_id":"ref-poc-001","payment_id":"pay-poc-001","decision":"APPROVED","approved_amount_minor":10000,"currency":"BRL"}',
      ) as object,
      'CTR-RUA-006',
    );
  });

  it('authorizes one full BRL refund', () => {
    assertRejected(withField(approvedDecision(), 'decision', 'REJECTED'), '/decision const', 'not approved');
    assertRejected(withField(approvedDecision(), 'currency', 'EUR'), '/currency const', 'non-BRL');
    assertRejected(withField(approvedDecision(), 'approved_amount_minor', 0), '/approved_amount_minor minimum', 'zero');
    assertRejected(
      withField(approvedDecision(), 'refund_request_id', '   '),
      '/refund_request_id pattern',
      'blank request',
    );
    assertRejected(withoutField(approvedDecision(), 'payment_id'), ' required', 'missing payment');
  });

  it('leaves amount equality with the payment to admission, a cross-record rule (D-31)', () => {
    assertAccepted(withField(approvedDecision(), 'approved_amount_minor', 5000), 'schema-valid partial amount');
  });
});

describe('trial_message (BR-RUA-036)', () => {
  it('accepts a run message and a variant-validation message', () => {
    assertAccepted(trialMessage(), 'run message');
    assertAccepted(inVariantValidation(trialMessage()), 'validation');
  });

  it('names exactly one of run_id or variant_validation_id', () => {
    assertRejected(withoutField(trialMessage(), 'run_id'), ' oneOf', 'no execution identity');
    assertRejected(withField(trialMessage(), 'variant_validation_id', IDS.variantValidation), ' oneOf', 'both');
    assertRejected(
      { ...withoutField(trialMessage(), 'run_id'), transport_probe_id: IDS.transportProbe },
      ' additionalProperties',
      'a probe has no trial message (D-06)',
    );
  });

  it('carries exactly the BR-RUA-036 correlation fields', () => {
    for (const field of ['trial_id', 'trial_manifest_sha256', 'payment_id', 'refund_request_id']) {
      assertRejected(withoutField(trialMessage(), field), ' required', `missing ${field}`);
    }
    assertRejected(
      withField(trialMessage(), 'trial_manifest_sha256', 'B'.repeat(64)),
      '/trial_manifest_sha256 pattern',
      'digest case',
    );
    assertRejected(
      withField(trialMessage(), 'execution_manifest_sha256', 'a'.repeat(64)),
      ' additionalProperties',
      'extra',
    );
  });
});
