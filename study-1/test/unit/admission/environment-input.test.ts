// Step A2 (BR-RUA-041): the operator's environment input bytes must parse, satisfy the closed
// schema, and name a coordination table and stack in the allowlisted account and `us-east-1`.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessEnvironmentInput, validateEnvironmentInput } from '../../../src/admission/environment-input.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  ACCOUNT_ID,
  FOREIGN_ACCOUNT_ID,
  STACK_ID,
  TABLE_ARN,
  environmentBytes,
  environmentInput,
} from '../../support/admission/admission-fixtures.ts';

const validator = createRecordValidator();

function codesOf(bytes: Uint8Array): readonly string[] {
  const verdict = assessEnvironmentInput(bytes, validator);
  return verdict.passed ? [] : verdict.reasons.map((reason) => reason.code);
}

describe('validateEnvironmentInput', () => {
  it('accepts the allowlisted input', () => {
    assert.deepEqual(validateEnvironmentInput(environmentInput(), validator), { ok: true, value: environmentInput() });
  });

  it('refuses a credential member with a summary and the first violations', () => {
    const result = validateEnvironmentInput(
      environmentInput({ aws_secret_access_key: 'x', session_token: 'y', password: 'z', role_arn: 'w' }),
      validator,
    );
    assert.ok(!result.ok);
    assert.equal(result.error.length, 4, 'a summary and three quoted violations');
    assert.match(result.error[0].detail, /^environment input has 4 schema violation\(s\); expected a closed/);
    assert.ok(result.error.every((reason) => reason.code === 'ENVIRONMENT_INPUT_INVALID'));
    assert.match(result.error[1]?.detail ?? '', /^environment input at \/ violates additionalProperties/);
  });

  it('quotes a nested violation at its instance path', () => {
    const result = validateEnvironmentInput(environmentInput({ account_allowlist: ['12345'] }), validator);
    assert.ok(!result.ok);
    assert.match(result.error[1]?.detail ?? '', /^environment input at \/account_allowlist\/0 violates pattern/);
  });
});

describe('assessEnvironmentInput (A2)', () => {
  it('admits the input with its exact bytes, digest and account', () => {
    const bytes = environmentBytes();
    const verdict = assessEnvironmentInput(bytes, validator);
    assert.ok(verdict.passed);
    assert.deepEqual(verdict.value, {
      input: environmentInput(),
      bytes,
      sha256: sha256Hex(bytes),
      account_id: ACCOUNT_ID,
    });
    assert.deepEqual(verdict.statement, {
      subject: 'coordination_placement',
      expected: { account: ACCOUNT_ID, region: 'us-east-1' },
      observed: { coordination_table_arn: TABLE_ARN, coordination_stack_id: STACK_ID },
    });
  });

  it('refuses bytes that are not JSON as ACCOUNT', () => {
    const verdict = assessEnvironmentInput(new TextEncoder().encode('{"schema_version":'), validator);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'ACCOUNT');
    assert.equal(verdict.reasons[0].code, 'ENVIRONMENT_INPUT_UNREADABLE');
    assert.match(verdict.reasons[0].detail, /is not UTF-8 JSON \(/);
  });

  it('refuses a schema-invalid input as ACCOUNT', () => {
    const verdict = assessEnvironmentInput(environmentBytes(environmentInput({ schema_version: 2 })), validator);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'ACCOUNT');
    assert.equal(verdict.statement.subject, 'environment_input');
  });

  it('refuses coordination identifiers of another account, naming each', () => {
    const foreign = environmentInput({
      coordination_table_arn: TABLE_ARN.replace(ACCOUNT_ID, FOREIGN_ACCOUNT_ID),
      coordination_stack_id: STACK_ID.replace(ACCOUNT_ID, FOREIGN_ACCOUNT_ID),
    });
    const verdict = assessEnvironmentInput(environmentBytes(foreign), validator);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'ACCOUNT');
    assert.deepEqual(
      verdict.reasons.map((reason) => reason.code),
      ['COORDINATION_NOT_IN_ACCOUNT', 'COORDINATION_NOT_IN_ACCOUNT'],
    );
    assert.match(
      verdict.reasons[0].detail,
      /names account 109876543210; expected the allowlisted account 012345678901$/,
    );
  });

  it('refuses coordination identifiers in another Region as REGION', () => {
    const elsewhere = environmentInput({
      coordination_table_arn: TABLE_ARN.replace('us-east-1', 'us-west-2'),
    });
    const verdict = assessEnvironmentInput(environmentBytes(elsewhere), validator);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'REGION');
    assert.deepEqual(verdict.reasons, [
      {
        code: 'COORDINATION_NOT_IN_REGION',
        subject: 'BR-RUA-041',
        detail: `coordination_table_arn ${TABLE_ARN.replace('us-east-1', 'us-west-2')} names Region us-west-2; expected us-east-1`,
      },
    ]);
  });

  it('checks the account before the Region', () => {
    const both = environmentInput({
      coordination_stack_id: STACK_ID.replace(`us-east-1:${ACCOUNT_ID}`, `eu-west-1:${FOREIGN_ACCOUNT_ID}`),
    });
    assert.deepEqual(codesOf(environmentBytes(both)), ['COORDINATION_NOT_IN_ACCOUNT']);
  });
});
