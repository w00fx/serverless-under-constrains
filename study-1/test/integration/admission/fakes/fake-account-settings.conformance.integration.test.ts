// FakeAccountSettings conformance (design §12.2): for the same unreserved concurrency and the
// same Lambda error, the production reader over the real Lambda client answers what the fake
// answers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAccountSettingsReader } from '../../../../src/admission/aws/admission-aws-readers.ts';
import {
  DEFAULT_UNRESERVED_CONCURRENCY,
  FakeAccountSettings,
} from '../../../support/admission/fake-account-settings.ts';
import { ScriptedAdmissionEndpoint } from '../../../support/admission/scripted-admission-endpoint.ts';

describe('FakeAccountSettings conforms to the Lambda reader', () => {
  it('answers the same unreserved concurrency', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.answerAccountSettings({ UnreservedConcurrentExecutions: DEFAULT_UNRESERVED_CONCURRENCY });
    assert.deepEqual(
      await new FakeAccountSettings().readUnreservedConcurrency(),
      await createAccountSettingsReader(endpoint.clients.lambda).readUnreservedConcurrency(),
    );
  });

  it('fails with the same code and detail', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.fail('lambda:GetAccountSettings', {
      status: 429,
      code: 'TooManyRequestsException',
      message: 'Rate exceeded',
    });
    const fake = new FakeAccountSettings();
    fake.failWith('TooManyRequestsException', 'Rate exceeded');
    assert.deepEqual(
      await fake.readUnreservedConcurrency(),
      await createAccountSettingsReader(endpoint.clients.lambda).readUnreservedConcurrency(),
    );
  });
});
