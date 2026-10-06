// LambdaDurableExecutions over the real Lambda client (BR-RUA-048 step 5, RK-10): RUNNING
// executions are listed unqualified and under every recorded version, page by page, and stopped;
// a function or execution that is gone, or an execution that ended before the stop, is not
// running; a refused stop of a still-running execution and a looping cursor fail.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LambdaDurableExecutions } from '../../../../src/cleanup/aws/lambda-durable-executions.ts';
import { refuse, reply, ScriptedCleanupEndpoint } from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';
import { NAMES } from '../../../support/cleanup/cleanup-fixtures.ts';

const FUNCTION = NAMES.durableFunction;
const FUNCTION_ARN = `arn:aws:lambda:us-east-1:123456789012:function:${FUNCTION}`;

function executionArn(qualifier: string, id: string): string {
  return `${FUNCTION_ARN}:${qualifier}/durable-execution/${id}/0f0e`;
}

function running(
  ...arns: readonly string[]
): { DurableExecutionArn: string; Status: string; DurableExecutionName: string }[] {
  return arns.map((arn) => ({ DurableExecutionArn: arn, Status: 'RUNNING', DurableExecutionName: 'n' }));
}

describe('LambdaDurableExecutions.listRunning', () => {
  it('lists unqualified and under each recorded version, every page, each execution once', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.respond('lambda:ListDurableExecutionsByFunction', (call) => {
      if (call.input['Qualifier'] === '3' && call.input['Marker'] === undefined) {
        return reply({ DurableExecutions: running(executionArn('3', 'a')), NextMarker: 'm-1' });
      }
      if (call.input['Qualifier'] === '3') {
        return reply({ DurableExecutions: running(executionArn('3', 'b'), executionArn('3', 'a')) });
      }
      return reply({ DurableExecutions: [] });
    });
    const durable = new LambdaDurableExecutions(endpoint.clients.lambda, [
      { function_name: FUNCTION, qualifiers: ['3', '4'] },
    ]);
    assert.deepEqual(await durable.listRunning(FUNCTION), {
      ok: true,
      running_execution_arns: [executionArn('3', 'a'), executionArn('3', 'b')],
    });
    assert.deepEqual(
      endpoint.calls().map((call) => call.input),
      [
        { FunctionName: FUNCTION, Statuses: ['RUNNING'] },
        { FunctionName: FUNCTION, Qualifier: '3', Statuses: ['RUNNING'] },
        { FunctionName: FUNCTION, Qualifier: '3', Statuses: ['RUNNING'], Marker: 'm-1' },
        { FunctionName: FUNCTION, Qualifier: '4', Statuses: ['RUNNING'] },
      ],
    );
  });

  it('lists a function it was not bound to unqualified, and none for a function that is gone', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:ListDurableExecutionsByFunction', refuse('ResourceNotFoundException', 'no function', 404));
    const durable = new LambdaDurableExecutions(endpoint.clients.lambda, []);
    assert.deepEqual(await durable.listRunning('other'), { ok: true, running_execution_arns: [] });
    assert.equal(endpoint.calls().length, 1);
  });

  it('fails a listing whose cursor repeats or whose service refuses', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:ListDurableExecutionsByFunction', reply({ DurableExecutions: [], NextMarker: 'same' }));
    const looping = await new LambdaDurableExecutions(endpoint.clients.lambda, []).listRunning(FUNCTION);
    assert.equal(!looping.ok && looping.reason.code, 'PAGINATION_CURSOR_REPEATED');
    endpoint.answer('lambda:ListDurableExecutionsByFunction', refuse('ServiceException', 'down', 500));
    const refused = await new LambdaDurableExecutions(endpoint.clients.lambda, []).listRunning(FUNCTION);
    assert.equal(!refused.ok && refused.reason.code, 'SERVICE_EXCEPTION');
  });
});

describe('LambdaDurableExecutions.stop', () => {
  const ARN = executionArn('3', 'a');

  it('stops a running execution with one request', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:StopDurableExecution', reply({ StopTimestamp: 1_791_201_600 }));
    assert.deepEqual(await new LambdaDurableExecutions(endpoint.clients.lambda, []).stop(ARN), { kind: 'stopped' });
    assert.deepEqual(
      endpoint.calls().map((call) => [call.operation, call.input]),
      [['StopDurableExecution', { DurableExecutionArn: ARN }]],
    );
  });

  it('reads an execution that is gone as not running, without a status read', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:StopDurableExecution', refuse('ResourceNotFoundException', 'gone', 404));
    assert.deepEqual(await new LambdaDurableExecutions(endpoint.clients.lambda, []).stop(ARN), { kind: 'not_running' });
    assert.deepEqual(endpoint.operations(), ['lambda:StopDurableExecution']);
  });

  it('reads a refused stop by the execution status: ended is not running, running is failed', async () => {
    const endpoint = new ScriptedCleanupEndpoint();
    endpoint.answer('lambda:StopDurableExecution', refuse('InvalidParameterValueException', 'not running'));
    endpoint.answer(
      'lambda:GetDurableExecution',
      reply({ DurableExecutionArn: ARN, Status: 'SUCCEEDED' }),
      refuse('ResourceNotFoundException', 'gone', 404),
      reply({ DurableExecutionArn: ARN, Status: 'RUNNING' }),
    );
    const durable = new LambdaDurableExecutions(endpoint.clients.lambda, []);
    assert.deepEqual(await durable.stop(ARN), { kind: 'not_running' });
    assert.deepEqual(await durable.stop(ARN), { kind: 'not_running' });
    const failed = await durable.stop(ARN);
    assert.deepEqual(failed, {
      kind: 'failed',
      reason: {
        code: 'INVALID_PARAMETER_VALUE_EXCEPTION',
        subject: ARN,
        detail: 'InvalidParameterValueException: not running; expected the running execution to stop',
      },
    });
    assert.deepEqual(endpoint.calls('lambda:GetDurableExecution')[0]?.input, { DurableExecutionArn: ARN });
  });
});
