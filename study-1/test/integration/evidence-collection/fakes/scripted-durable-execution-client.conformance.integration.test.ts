// Conformance of ScriptedDurableExecutionClient (design §12.2): its responses are what the SDK's
// own restJson1 deserializer accepts as Lambda answers — epoch-second timestamps decoded to Dates,
// a missing execution as the SDK's ResourceNotFoundException class, a scripted error by its type —
// and its model filters a listing by function, Qualifier and StartedAfter and pages by Marker.
// The collector only reads, so any other operation is refused.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GetDurableExecutionCommand,
  GetDurableExecutionHistoryCommand,
  ListDurableExecutionsByFunctionCommand,
  ResourceNotFoundException,
  StopDurableExecutionCommand,
} from '@aws-sdk/client-lambda';
import type { ListDurableExecutionsByFunctionCommandOutput } from '@aws-sdk/client-lambda';

import { DURABLE_FUNCTION_ARN } from '../../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDurableExecutionClient } from '../../../support/evidence-collection/scripted-durable-execution-client.ts';
import type { ModelledDurableExecution } from '../../../support/evidence-collection/scripted-durable-execution-client.ts';

const STARTED_MS = Date.UTC(2026, 9, 5, 12, 5, 1);

function execution(name: string, overrides: Partial<ModelledDurableExecution> = {}): ModelledDurableExecution {
  return {
    arn: `${DURABLE_FUNCTION_ARN}:3/durable-execution/${name}/run`,
    name,
    function_arn: DURABLE_FUNCTION_ARN,
    qualifier: '3',
    status: 'SUCCEEDED',
    started_ms: STARTED_MS,
    ended_ms: STARTED_MS + 1500,
    history: [{ EventType: 'ExecutionStarted', EventId: 1, EventTimestamp: STARTED_MS / 1000 }],
    ...overrides,
  };
}

describe('ScriptedDurableExecutionClient conformance', () => {
  it('lists by function, Qualifier and StartedAfter, paging by Marker', async () => {
    const lambda = new ScriptedDurableExecutionClient(1);
    lambda.addExecution(execution('a'));
    lambda.addExecution(execution('b'));
    lambda.addExecution(execution('other-version', { qualifier: '2' }));
    lambda.addExecution(execution('before', { started_ms: STARTED_MS - 60_000 }));
    lambda.addExecution(execution('other-function', { function_arn: `${DURABLE_FUNCTION_ARN}-x` }));
    const list = (marker?: string): Promise<ListDurableExecutionsByFunctionCommandOutput> =>
      lambda.client.send(
        new ListDurableExecutionsByFunctionCommand({
          FunctionName: DURABLE_FUNCTION_ARN,
          Qualifier: '3',
          StartedAfter: new Date(STARTED_MS - 1000),
          ...(marker === undefined ? {} : { Marker: marker }),
        }),
      );
    const first = await list();
    assert.deepEqual(
      first.DurableExecutions?.map((entry) => entry.DurableExecutionName),
      ['a'],
    );
    const second = await list(first.NextMarker);
    assert.deepEqual(
      second.DurableExecutions?.map((entry) => entry.DurableExecutionName),
      ['b'],
    );
    assert.equal(second.NextMarker, undefined);
  });

  it('lists every qualifier when none is given', async () => {
    const lambda = new ScriptedDurableExecutionClient();
    lambda.addExecution(execution('a'));
    lambda.addExecution(execution('b', { qualifier: '2' }));
    const output = await lambda.client.send(
      new ListDurableExecutionsByFunctionCommand({ FunctionName: DURABLE_FUNCTION_ARN }),
    );
    assert.equal(output.DurableExecutions?.length, 2);
  });

  it('decodes epoch-second timestamps to Dates, and omits an end a RUNNING execution lacks', async () => {
    const lambda = new ScriptedDurableExecutionClient();
    lambda.addExecution(execution('done', { version: '3' }));
    const { ended_ms: _neverEnded, ...running } = execution('running', { status: 'RUNNING' });
    lambda.addExecution(running);
    const done = await lambda.client.send(
      new GetDurableExecutionCommand({ DurableExecutionArn: execution('done').arn }),
    );
    assert.deepEqual(done.StartTimestamp, new Date(STARTED_MS));
    assert.deepEqual(done.EndTimestamp, new Date(STARTED_MS + 1500));
    assert.equal(done.Version, '3');
    const live = await lambda.client.send(new GetDurableExecutionCommand({ DurableExecutionArn: running.arn }));
    assert.equal(live.EndTimestamp, undefined);
    assert.equal(live.Version, undefined);
    const history = await lambda.client.send(
      new GetDurableExecutionHistoryCommand({ DurableExecutionArn: running.arn }),
    );
    assert.deepEqual(history.Events?.[0]?.EventTimestamp, new Date(STARTED_MS));
  });

  it('fails a missing execution as the SDK ResourceNotFoundException and a scripted error by type', async () => {
    const lambda = new ScriptedDurableExecutionClient();
    await assert.rejects(
      lambda.client.send(new GetDurableExecutionCommand({ DurableExecutionArn: 'arn:missing' })),
      (error: unknown) => error instanceof ResourceNotFoundException,
    );
    lambda.scriptError('TooManyRequestsException', 429);
    await assert.rejects(
      lambda.client.send(new ListDurableExecutionsByFunctionCommand({ FunctionName: DURABLE_FUNCTION_ARN })),
      { name: 'TooManyRequestsException' },
    );
    assert.equal(lambda.calls().length, 2);
  });

  it('refuses an operation the collector never sends', async () => {
    const lambda = new ScriptedDurableExecutionClient();
    lambda.addExecution(execution('a'));
    await assert.rejects(
      lambda.client.send(new StopDurableExecutionCommand({ DurableExecutionArn: execution('a').arn })),
      { name: 'InvalidRequestContentException' },
    );
  });
});
