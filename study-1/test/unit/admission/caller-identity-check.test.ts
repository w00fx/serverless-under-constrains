// Step A7 (ACCOUNT / REGION; BR-RUA-041): the caller account is exactly the allowlisted 12-digit
// account, compared as a string, and the Region is us-east-1.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessCallerIdentity } from '../../../src/admission/caller-identity-check.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import { ACCOUNT_ID, CALLER_ARN, FOREIGN_ACCOUNT_ID } from '../../support/admission/admission-fixtures.ts';

const IDENTITY = { account: ACCOUNT_ID, arn: CALLER_ARN, region: 'us-east-1' };

describe('assessCallerIdentity (A7)', () => {
  it('admits the allowlisted account in us-east-1', () => {
    assert.deepEqual(assessCallerIdentity(ok(IDENTITY), ACCOUNT_ID), {
      passed: true,
      value: IDENTITY,
      statement: {
        subject: 'caller_identity',
        expected: { account: ACCOUNT_ID, region: 'us-east-1' },
        observed: { account: ACCOUNT_ID, region: 'us-east-1' },
      },
    });
  });

  it('refuses an unreadable identity as ACCOUNT', () => {
    const verdict = assessCallerIdentity(err({ code: 'ExpiredToken', detail: 'expired' }), ACCOUNT_ID);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'ACCOUNT');
    assert.equal(verdict.reasons[0].code, 'CALLER_IDENTITY_UNREADABLE');
  });

  it('refuses another account, and the same digits without a leading zero', () => {
    for (const account of [FOREIGN_ACCOUNT_ID, '12345678901']) {
      const verdict = assessCallerIdentity(ok({ ...IDENTITY, account }), ACCOUNT_ID);
      assert.ok(!verdict.passed);
      assert.equal(verdict.rejection_class, 'ACCOUNT');
      assert.equal(
        verdict.reasons[0].detail,
        `caller account is ${account}; expected exactly the allowlisted 12-digit account ${ACCOUNT_ID}`,
      );
    }
  });

  it('refuses an account that is not 12 digits even when the allowlist names it', () => {
    const verdict = assessCallerIdentity(ok({ ...IDENTITY, account: 'root' }), 'root');
    assert.ok(!verdict.passed);
    assert.equal(verdict.reasons[0].code, 'ACCOUNT_NOT_ALLOWLISTED');
  });

  it('refuses another Region as REGION', () => {
    const verdict = assessCallerIdentity(ok({ ...IDENTITY, region: 'us-east-2' }), ACCOUNT_ID);
    assert.ok(!verdict.passed);
    assert.equal(verdict.rejection_class, 'REGION');
    assert.deepEqual(verdict.reasons, [
      {
        code: 'REGION_NOT_ALLOWED',
        subject: 'BR-RUA-041',
        detail: 'the configured Region is us-east-2; expected us-east-1',
      },
    ]);
  });
});
