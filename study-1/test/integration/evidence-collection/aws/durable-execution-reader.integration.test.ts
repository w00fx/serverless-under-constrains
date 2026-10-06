// The Lambda binding of the collector's DurableExecutionReader through a real LambdaClient (design
// §5.3; BR-RUA-020, RK-10): the wire requests of the three reads (function and qualifier,
// StartedAfter, markers, no execution data), the pinned client options, errors by their SDK
// names, and the metadata collection driven end to end through the binding across pages.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COLLECTOR_LAMBDA_CLIENT_OPTIONS,
  createCollectorLambdaClient,
  createLambdaDurableExecutionReader,
} from '../../../../src/evidence-collection/aws/durable-execution-reader.ts';
import type { CollectorLambdaClientSettings } from '../../../../src/evidence-collection/aws/durable-execution-reader.ts';
import { collectDurableExecutionMetadata } from '../../../../src/evidence-collection/durable-metadata.ts';
import type { DurableListingRequest } from '../../../../src/evidence-collection/durable-metadata.ts';
import type { JsonObject, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import {
  assertValidRecord,
  collectionClock,
  DURABLE_FUNCTION_ARN,
  TRIAL_SCOPE,
} from '../../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDurableExecutionClient } from '../../../support/evidence-collection/scripted-durable-execution-client.ts';
import type { ModelledDurableExecution } from '../../../support/evidence-collection/scripted-durable-execution-client.ts';

const PUBLISHED_MS = Date.UTC(2026, 9, 5, 12, 5);
const REQUEST: DurableListingRequest = {
  function_arn: DURABLE_FUNCTION_ARN,
  qualifier: '3',
  started_after: '2026-10-05T12:05:00.000Z' as UtcMillis,
};

function modelled(serial: number, overrides: Partial<ModelledDurableExecution> = {}): ModelledDurableExecution {
  const startedMs = PUBLISHED_MS + serial * 1000;
  return {
    arn: `${DURABLE_FUNCTION_ARN}:3/durable-execution/exec-${String(serial)}/run`,
    name: `exec-${String(serial)}`,
    function_arn: DURABLE_FUNCTION_ARN,
    qualifier: '3',
    status: 'SUCCEEDED',
    started_ms: startedMs,
    ended_ms: startedMs + 500,
    version: '3',
    history: [
      { EventType: 'ExecutionStarted', EventId: 1, EventTimestamp: startedMs / 1000 },
      { EventType: 'ExecutionSucceeded', EventId: 2, EventTimestamp: (startedMs + 500) / 1000 },
    ],
    ...overrides,
  };
}

describe('createCollectorLambdaClient', () => {
  it('pins us-east-1 and a single attempt, even against a smuggled override', async () => {
    const smuggled = { region: 'eu-west-1', maxAttempts: 4 } as unknown as CollectorLambdaClientSettings;
    const client = createCollectorLambdaClient(smuggled);
    assert.equal(await client.config.region(), COLLECTOR_LAMBDA_CLIENT_OPTIONS.region);
    assert.equal(await client.config.maxAttempts(), 1);
  });

  it('sends a retryable failure once', async () => {
    const lambda = new ScriptedDurableExecutionClient();
    lambda.scriptError('ServiceException', 500);
    const page = await createLambdaDurableExecutionReader(lambda.client).listPage(REQUEST);
    assert.deepEqual(page, { ok: false, error: { code: 'ServiceException' } });
    assert.equal(lambda.calls().length, 1);
  });
});

describe('createLambdaDurableExecutionReader', () => {
  it('lists by function, qualifier and StartedAfter, and passes the marker back', async () => {
    const lambda = new ScriptedDurableExecutionClient(1);
    lambda.addExecution(modelled(1));
    lambda.addExecution(modelled(2));
    const reader = createLambdaDurableExecutionReader(lambda.client);
    const first = await reader.listPage(REQUEST);
    assert.ok(first.ok);
    assert.equal(first.value.NextMarker, '1');
    const second = await reader.listPage(REQUEST, first.value.NextMarker);
    assert.ok(second.ok);
    assert.equal(second.value.NextMarker, undefined);
    const [firstCall, secondCall] = lambda.calls();
    assert.equal(firstCall?.method, 'GET');
    assert.equal(
      firstCall.path,
      `/2025-12-01/functions/${encodeURIComponent(DURABLE_FUNCTION_ARN)}/durable-executions`,
    );
    assert.equal(firstCall.query['Qualifier'], '3');
    assert.equal(Date.parse(String(firstCall.query['StartedAfter'])), PUBLISHED_MS);
    assert.equal(firstCall.query['Marker'], undefined);
    assert.equal(secondCall?.query['Marker'], '1');
  });

  it('returns the SDK shapes: Date timestamps and the execution members as given', async () => {
    const lambda = new ScriptedDurableExecutionClient();
    const execution = modelled(1);
    lambda.addExecution(execution);
    const detail = await createLambdaDurableExecutionReader(lambda.client).getExecution(execution.arn);
    assert.ok(detail.ok);
    assert.equal(detail.value.DurableExecutionArn, execution.arn);
    assert.equal(detail.value.Status, 'SUCCEEDED');
    assert.deepEqual(detail.value.StartTimestamp, new Date(execution.started_ms));
  });

  it('reads history without execution data, by marker', async () => {
    const lambda = new ScriptedDurableExecutionClient(1);
    const execution = modelled(1);
    lambda.addExecution(execution);
    const reader = createLambdaDurableExecutionReader(lambda.client);
    const first = await reader.historyPage(execution.arn);
    assert.ok(first.ok);
    await reader.historyPage(execution.arn, first.value.NextMarker);
    const [firstCall, secondCall] = lambda.calls();
    assert.equal(firstCall?.path, `/2025-12-01/durable-executions/${encodeURIComponent(execution.arn)}/history`);
    assert.equal(firstCall.query['IncludeExecutionData'], 'false');
    assert.equal(firstCall.query['Marker'], undefined);
    assert.equal(secondCall?.query['Marker'], '1');
  });

  it('reports an unknown execution and a throttle by their SDK error names', async () => {
    const lambda = new ScriptedDurableExecutionClient();
    const reader = createLambdaDurableExecutionReader(lambda.client);
    assert.deepEqual(await reader.getExecution('arn:missing'), {
      ok: false,
      error: { code: 'ResourceNotFoundException' },
    });
    lambda.scriptError('TooManyRequestsException', 429);
    assert.deepEqual(await reader.historyPage('arn:missing'), {
      ok: false,
      error: { code: 'TooManyRequestsException' },
    });
  });
});

describe('collectDurableExecutionMetadata through the Lambda binding', () => {
  it('records every execution of the version, with its history, across pages', async () => {
    const lambda = new ScriptedDurableExecutionClient(1);
    lambda.addExecution(modelled(1));
    const { ended_ms: _neverEnded, ...running } = modelled(2, { status: 'RUNNING' });
    lambda.addExecution(running);
    lambda.addExecution(modelled(3, { qualifier: '2' }));
    lambda.addExecution({ ...modelled(4), started_ms: PUBLISHED_MS - 60_000 });
    const metadata = await collectDurableExecutionMetadata(
      createLambdaDurableExecutionReader(lambda.client),
      REQUEST,
      TRIAL_SCOPE,
      collectionClock(),
    );
    assert.deepEqual(metadata.failures, []);
    assert.equal(metadata.inner_executions_terminal, false);
    assertValidRecord(metadata.record, 'durable_execution_metadata');
    const executions = metadata.record['executions'] as readonly JsonObject[];
    assert.deepEqual(
      executions.map((execution) => [execution['durable_execution_name'], execution['status']]),
      [
        ['exec-1', 'SUCCEEDED'],
        ['exec-2', 'RUNNING'],
      ],
    );
    const [finished] = executions;
    assert.deepEqual(
      (finished?.['history'] as readonly JsonObject[]).map((event) => event['event_type']),
      ['ExecutionStarted', 'ExecutionSucceeded'],
    );
  });
});
