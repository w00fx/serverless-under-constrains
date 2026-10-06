// FakeBootstrapStack conformance (design §12.2): for an existing stack, a missing stack and a
// failed read, the production reader over the real CloudFormation client answers what the fake
// answers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBootstrapStackReader } from '../../../../src/admission/aws/admission-aws-readers.ts';
import { FakeBootstrapStack } from '../../../support/admission/fake-bootstrap-stack.ts';
import { ScriptedAdmissionEndpoint } from '../../../support/admission/scripted-admission-endpoint.ts';

describe('FakeBootstrapStack conforms to the CloudFormation reader', () => {
  for (const status of ['UPDATE_COMPLETE', 'ROLLBACK_COMPLETE', undefined]) {
    it(`answers the same for a stack ${status ?? 'that does not exist'}`, async () => {
      const endpoint = new ScriptedAdmissionEndpoint();
      endpoint.answerBootstrapStack(status);
      const fake = status === undefined ? new FakeBootstrapStack() : new FakeBootstrapStack(status);
      if (status === undefined) {
        fake.removeStack();
      }
      assert.deepEqual(
        await fake.readBootstrapStackStatus(),
        await createBootstrapStackReader(endpoint.clients.cloudformation).readBootstrapStackStatus(),
      );
    });
  }

  it('fails with the same code and detail', async () => {
    const endpoint = new ScriptedAdmissionEndpoint();
    endpoint.fail('cloudformation:DescribeStacks', { status: 400, code: 'Throttling', message: 'Rate exceeded' });
    const fake = new FakeBootstrapStack();
    fake.failWith('Throttling', 'Rate exceeded');
    assert.deepEqual(
      await fake.readBootstrapStackStatus(),
      await createBootstrapStackReader(endpoint.clients.cloudformation).readBootstrapStackStatus(),
    );
  });
});
