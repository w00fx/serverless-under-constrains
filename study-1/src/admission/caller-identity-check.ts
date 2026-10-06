// Admission step A7 (ACCOUNT / REGION; BR-RUA-041, design §10.1): `sts:GetCallerIdentity` must
// resolve to exactly the allowlisted 12-digit account, compared as strings so leading zeros
// count, and the clients must be configured for `us-east-1`. An unreadable identity is an
// account rejection: admission never acts for an account it could not confirm.

import { boundedText } from '../record-contract/json-value.ts';
import type { Result } from '../record-contract/primitives.ts';
import { SAFETY_REGION } from '../safety/safety-limits.ts';
import type { CallerIdentity, PortFailure } from './admission-ports.ts';
import { admissionReason, portFailureReason } from './admission-reason.ts';
import { failed, passed } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';

const SUBJECT = 'BR-RUA-041';
const ACCOUNT_PATTERN = /^\d{12}$/;

/**
 * Step A7: the caller account equals the allowlisted account and the Region is `us-east-1`.
 *
 * @example
 * assessCallerIdentity(ok({ account: '012345678901', arn, region: 'us-east-1' }), '012345678901').passed; // true
 */
export function assessCallerIdentity(
  reading: Result<CallerIdentity, PortFailure>,
  allowlistedAccount: string,
): StepVerdict<CallerIdentity> {
  const expected = { account: allowlistedAccount, region: SAFETY_REGION };
  if (!reading.ok) {
    return failed('ACCOUNT', { subject: 'caller_identity', expected }, [
      portFailureReason('CALLER_IDENTITY_UNREADABLE', SUBJECT, 'sts:GetCallerIdentity', reading.error),
    ]);
  }
  const identity = reading.value;
  const statement: CheckStatement = {
    subject: 'caller_identity',
    expected,
    observed: { account: boundedText(identity.account), region: boundedText(identity.region) },
  };
  if (!ACCOUNT_PATTERN.test(identity.account) || identity.account !== allowlistedAccount) {
    return failed('ACCOUNT', statement, [
      admissionReason(
        'ACCOUNT_NOT_ALLOWLISTED',
        SUBJECT,
        `caller account is ${boundedText(identity.account)}; expected exactly the allowlisted 12-digit account ${allowlistedAccount}`,
      ),
    ]);
  }
  if (identity.region !== SAFETY_REGION) {
    return failed('REGION', statement, [
      admissionReason(
        'REGION_NOT_ALLOWED',
        SUBJECT,
        `the configured Region is ${boundedText(identity.region)}; expected ${SAFETY_REGION}`,
      ),
    ]);
  }
  return passed(identity, statement);
}
