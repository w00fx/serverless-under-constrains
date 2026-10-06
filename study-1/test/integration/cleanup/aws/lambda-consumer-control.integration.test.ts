// LambdaConsumerControl over the real Lambda client (BR-RUA-048 step 3): the disable request and
// the state read as Lambda receives them, a mapping that no longer exists read absent, and any
// other failure, or a state answer without `State`, reported failed after exactly one request.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LambdaConsumerControl } from '../../../../src/cleanup/aws/lambda-consumer-control.ts';
import { refuse, reply, ScriptedCleanupEndpoint } from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';
import { NAMES } from '../../../support/cleanup/cleanup-fixtures.ts';

const UUID = NAMES.sourceMapping;

describe('LambdaConsumerControl', () => {
  it('asks Lambda to disable the mapping by UUID', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:UpdateEventSourceMapping', reply({ UUID, State: 'Disabling' }));
    const outcome = await new LambdaConsumerControl(endpoint.clients.lambda).requestDisable(UUID);
    assert.deepEqual(outcome, { kind: 'requested' });
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.region, call.input]),
      [['UpdateEventSourceMapping', 'us-east-1', { UUID, Enabled: false }]],
    );
  });

  it('reads a disable of a mapping that no longer exists as absent', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:UpdateEventSourceMapping', refuse('ResourceNotFoundException', 'gone', 404));
    assert.deepEqual(await new LambdaConsumerControl(endpoint.clients.lambda).requestDisable(UUID), { kind: 'absent' });
  });

  it('reports a refused disable failed after one request', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:UpdateEventSourceMapping', refuse('TooManyRequestsException', 'slow down', 429));
    const outcome = await new LambdaConsumerControl(endpoint.clients.lambda).requestDisable(UUID);
    assert.deepEqual(outcome, {
      kind: 'failed',
      reason: {
        code: 'TOO_MANY_REQUESTS_EXCEPTION',
        subject: UUID,
        detail: 'TooManyRequestsException: slow down; expected the mapping disable to be accepted',
      },
    });
    assert.equal(endpoint.calls().length, 1);
  });

  it('reads the mapping state, absent once it is gone, and failed for an answer without one', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer(
      'lambda:GetEventSourceMapping',
      reply({ UUID, State: 'Disabled' }),
      refuse('ResourceNotFoundException', 'gone', 404),
      reply({ UUID }),
    );
    const consumers = new LambdaConsumerControl(endpoint.clients.lambda);
    assert.deepEqual(await consumers.readState(UUID), { kind: 'state', state: 'Disabled' });
    assert.deepEqual(await consumers.readState(UUID), { kind: 'absent' });
    const malformed = await consumers.readState(UUID);
    assert.equal(malformed.kind === 'failed' && malformed.reason.code, 'SDK_OUTPUT_MALFORMED');
    assert.deepEqual(
      endpoint.calls().map((call) => call.input),
      [{ UUID }, { UUID }, { UUID }],
    );
  });
});
