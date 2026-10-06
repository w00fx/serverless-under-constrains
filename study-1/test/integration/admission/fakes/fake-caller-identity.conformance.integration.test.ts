// FakeCallerIdentity conformance (design §12.2): for the same identity and the same STS error,
// the production reader over the real STS client and a scripted endpoint answers what the fake
// answers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCallerIdentityReader } from '../../../../src/admission/aws/admission-aws-readers.ts';
import { ACCOUNT_ID, CALLER_ARN } from '../../../support/admission/admission-fixtures.ts';
import { FakeCallerIdentity } from '../../../support/admission/fake-caller-identity.ts';
import { ScriptedAdmissionEndpoint } from '../../../support/admission/scripted-admission-endpoint.ts';

describe('FakeCallerIdentity conforms to the STS reader', () => {
  it('answers the same identity', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.answerCallerIdentity(ACCOUNT_ID, CALLER_ARN);
    assert.deepEqual(
      await new FakeCallerIdentity().readCallerIdentity(),
      await createCallerIdentityReader(endpoint.clients.sts).readCallerIdentity(),
    );
  });

  it('fails with the same code and detail', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.fail('sts:GetCallerIdentity', {
      status: 403,
      code: 'ExpiredToken',
      message: 'The security token expired',
    });
    const fake = new FakeCallerIdentity();
    fake.failWith('ExpiredToken', 'The security token expired');
    assert.deepEqual(
      await fake.readCallerIdentity(),
      await createCallerIdentityReader(endpoint.clients.sts).readCallerIdentity(),
    );
    assert.equal(fake.readCount(), 1);
  });
});
