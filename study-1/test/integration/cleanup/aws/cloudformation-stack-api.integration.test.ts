// CloudFormationStackApi over the real CloudFormation client (BR-RUA-048 step 9, BR-RUA-050): the
// recorded stack is described and deleted by its id; "does not exist" and DELETE_COMPLETE read
// absent; any other failure is reported failed after one request.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CloudFormationStackApi } from '../../../../src/cleanup/aws/cloudformation-stack-api.ts';
import { refuse, reply, ScriptedCleanupEndpoint } from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';
import { STACK_ID, STACK_NAME } from '../../../support/cleanup/cleanup-fixtures.ts';

function stacksXml(status: string): string {
  return (
    `<Stacks><member><StackId>${STACK_ID}</StackId><StackName>${STACK_NAME}</StackName>` +
    `<CreationTime>2026-10-05T11:05:00.000Z</CreationTime><StackStatus>${status}</StackStatus></member></Stacks>`
  );
}

describe('CloudFormationStackApi', () => {
  it('describes the stack by its recorded id', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer(
      'cloudformation:DescribeStacks',
      reply(stacksXml('DELETE_IN_PROGRESS')),
      reply(stacksXml('DELETE_COMPLETE')),
    );
    const stacks = new CloudFormationStackApi(endpoint.clients.cloudformation);
    assert.deepEqual(await stacks.describe(STACK_ID), { kind: 'present', status: 'DELETE_IN_PROGRESS' });
    assert.deepEqual(await stacks.describe(STACK_ID), { kind: 'absent' });
    assert.deepEqual(
      endpoint.calls().map((call) => [call.region, call.input['StackName']]),
      [
        ['us-east-1', STACK_ID],
        ['us-east-1', STACK_ID],
      ],
    );
  });

  it('reads "does not exist" as absent and any other failure as failed', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer(
      'cloudformation:DescribeStacks',
      refuse('ValidationError', `Stack with id ${STACK_ID} does not exist`),
      refuse('ValidationError', 'Rate exceeded'),
      reply('<Stacks></Stacks>'),
    );
    const stacks = new CloudFormationStackApi(endpoint.clients.cloudformation);
    assert.deepEqual(await stacks.describe(STACK_ID), { kind: 'absent' });
    assert.deepEqual(await stacks.describe(STACK_ID), {
      kind: 'failed',
      reason: {
        code: 'VALIDATION_ERROR',
        subject: STACK_ID,
        detail: 'ValidationError: Rate exceeded; expected the stack description',
      },
    });
    assert.deepEqual(await stacks.describe(STACK_ID), { kind: 'absent' });
    assert.equal(endpoint.calls().length, 3);
  });

  it('requests the deletion by id and reports a refused one failed', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('cloudformation:DeleteStack', reply(''), refuse('TokenAlreadyExistsException', 'busy'));
    const stacks = new CloudFormationStackApi(endpoint.clients.cloudformation);
    assert.deepEqual(await stacks.requestDelete(STACK_ID), { kind: 'requested' });
    assert.deepEqual(await stacks.requestDelete(STACK_ID), {
      kind: 'failed',
      reason: {
        code: 'TOKEN_ALREADY_EXISTS_EXCEPTION',
        subject: STACK_ID,
        detail: 'TokenAlreadyExistsException: busy; expected the stack deletion to be accepted',
      },
    });
    assert.deepEqual(endpoint.calls()[0]?.input, { Action: 'DeleteStack', Version: '2010-05-15', StackName: STACK_ID });
  });
});
