// Durable execution metadata (design §5.3; BR-RUA-020, BR-RUA-037, RK-10): every execution of the
// caller version started after publication, each read and its history paged, with completeness
// flags that turn false whenever a page or an entry could not be read.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildDurableExecutionMetadata,
  collectDurableExecutionMetadata,
  innerExecutionsTerminal,
  listDurableExecutions,
} from '../../../src/evidence-collection/durable-metadata.ts';
import type { DurableListingRequest } from '../../../src/evidence-collection/durable-metadata.ts';
import type { DurableExecutionSummary } from '../../../src/evidence-collection/durable-sdk-mapping.ts';
import type { JsonObject, UtcMillis } from '../../../src/record-contract/primitives.ts';
import {
  assertValidRecord,
  collectionClock,
  DURABLE_FUNCTION_ARN,
  sdkEvent,
  sdkExecution,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDurableExecutionReader } from '../../support/evidence-collection/scripted-durable-execution-reader.ts';

const REQUEST: DurableListingRequest = {
  function_arn: DURABLE_FUNCTION_ARN,
  qualifier: '3',
  started_after: '2026-10-05T12:05:00.000Z' as UtcMillis,
};

function executionsOf(record: JsonObject): readonly JsonObject[] {
  return record['executions'] as readonly JsonObject[];
}

describe('listDurableExecutions', () => {
  it('reads every listing page with the request', async () => {
    const reader = new ScriptedDurableExecutionReader(2);
    for (const serial of [1, 2, 3]) {
      reader.addExecution(sdkExecution(serial, 'SUCCEEDED'), []);
    }
    const listing = await listDurableExecutions(reader, REQUEST);
    assert.equal(listing.complete, true);
    assert.deepEqual(
      listing.executions.map((execution) => execution.durable_execution_name),
      ['exec-1', 'exec-2', 'exec-3'],
    );
    assert.deepEqual(reader.listingRequests(), [REQUEST, REQUEST]);
  });

  it('is incomplete after a failed page, a malformed entry or a repeated marker', async () => {
    const failing = new ScriptedDurableExecutionReader();
    failing.scriptFailure('listPage', 'TooManyRequestsException');
    const failed = await listDurableExecutions(failing, REQUEST);
    assert.deepEqual(
      [failed.complete, failed.failures.map((failure) => failure.code)],
      [false, ['DURABLE_PAGE_READ_FAILED']],
    );

    const malformed = new ScriptedDurableExecutionReader();
    malformed.addExecution({ ...sdkExecution(1, 'SUCCEEDED'), Status: 'PAUSED' }, []);
    malformed.addExecution(sdkExecution(2, 'RUNNING'), []);
    const partial = await listDurableExecutions(malformed, REQUEST);
    assert.equal(partial.complete, false);
    assert.deepEqual(
      partial.executions.map((execution) => execution.durable_execution_name),
      ['exec-2'],
    );
    assert.deepEqual(
      partial.failures.map((failure) => failure.code),
      ['DURABLE_RESPONSE_MALFORMED'],
    );

    const looping = new ScriptedDurableExecutionReader();
    looping.addExecution(sdkExecution(1, 'SUCCEEDED'), []);
    looping.scriptRepeatedMarker('listPage');
    const looped = await listDurableExecutions(looping, REQUEST);
    assert.equal(looped.complete, false);
    assert.match(looped.failures[0]?.detail ?? '', /marker "loop" repeated after page 2/);
  });

  it('treats a page without an execution member as empty', async () => {
    const reader = new ScriptedDurableExecutionReader();
    const listing = await listDurableExecutions(reader, REQUEST);
    assert.deepEqual([listing.complete, listing.executions], [true, []]);
  });
});

describe('innerExecutionsTerminal (§8.12)', () => {
  it('is true only for a complete listing with no RUNNING execution', () => {
    const ended: DurableExecutionSummary = {
      durable_execution_arn: 'a',
      durable_execution_name: 'n',
      status: 'FAILED',
      started_at: '2026-10-05T12:05:00.000Z' as UtcMillis,
    };
    assert.equal(innerExecutionsTerminal({ complete: true, executions: [] }), true);
    assert.equal(innerExecutionsTerminal({ complete: true, executions: [ended] }), true);
    assert.equal(
      innerExecutionsTerminal({ complete: true, executions: [ended, { ...ended, status: 'RUNNING' }] }),
      false,
    );
    assert.equal(innerExecutionsTerminal({ complete: false, executions: [ended] }), false);
  });
});

describe('collectDurableExecutionMetadata', () => {
  it('records each execution with its detail and paged history', async () => {
    const reader = new ScriptedDurableExecutionReader(2);
    const history = [
      sdkEvent('ExecutionStarted', 1),
      sdkEvent('StepStarted', 2, { Name: 'refund-attempt' }),
      sdkEvent('ExecutionSucceeded', 3),
    ];
    reader.addExecution(sdkExecution(1, 'SUCCEEDED'), history, { ...sdkExecution(1, 'SUCCEEDED'), Version: '3' });
    const metadata = await collectDurableExecutionMetadata(reader, REQUEST, TRIAL_SCOPE, collectionClock());
    assertValidRecord(metadata.record, 'durable_execution_metadata');
    assert.equal(metadata.inner_executions_terminal, true);
    assert.deepEqual(metadata.failures, []);
    assert.equal(metadata.record['list_complete'], true);
    assert.equal(metadata.record['started_after'], REQUEST.started_after);
    assert.equal(metadata.record['qualifier'], '3');
    const [execution] = executionsOf(metadata.record);
    assert.equal(execution?.['version'], '3');
    assert.equal(execution['history_complete'], true);
    assert.deepEqual(
      (execution['history'] as readonly JsonObject[]).map((event) => event['event_type']),
      ['ExecutionStarted', 'StepStarted', 'ExecutionSucceeded'],
    );
  });

  it('keeps the listed summary when the execution read fails or is malformed', async () => {
    const reader = new ScriptedDurableExecutionReader();
    reader.addExecution(sdkExecution(1, 'RUNNING'), []);
    reader.addExecution(sdkExecution(2, 'SUCCEEDED'), [], { ...sdkExecution(2, 'SUCCEEDED'), Status: 'UNKNOWN' });
    reader.scriptFailure('getExecution', 'ServiceException');
    const metadata = await collectDurableExecutionMetadata(reader, REQUEST, TRIAL_SCOPE, collectionClock());
    assertValidRecord(metadata.record);
    assert.deepEqual(
      executionsOf(metadata.record).map((execution) => [execution['durable_execution_name'], execution['status']]),
      [
        ['exec-1', 'RUNNING'],
        ['exec-2', 'SUCCEEDED'],
      ],
    );
    assert.deepEqual(
      metadata.failures.map((failure) => failure.code),
      ['DURABLE_EXECUTION_READ_FAILED', 'DURABLE_RESPONSE_MALFORMED'],
    );
    assert.equal(metadata.inner_executions_terminal, false, 'exec-1 is RUNNING (RK-10)');
  });

  it('marks a history incomplete when a page fails or an event is malformed', async () => {
    const reader = new ScriptedDurableExecutionReader(1);
    reader.addExecution(sdkExecution(1, 'SUCCEEDED'), [sdkEvent('ExecutionStarted', 1), sdkEvent('StepStarted', 2)]);
    reader.addExecution(sdkExecution(2, 'SUCCEEDED'), [sdkEvent('lowercase', 1)]);
    reader.scriptFailure('historyPage', 'ThrottlingException');
    const metadata = await collectDurableExecutionMetadata(reader, REQUEST, TRIAL_SCOPE, collectionClock());
    assertValidRecord(metadata.record);
    assert.deepEqual(
      executionsOf(metadata.record).map((execution) => execution['history_complete']),
      [false, false],
    );
    assert.deepEqual(
      metadata.failures.map((failure) => failure.code),
      ['DURABLE_PAGE_READ_FAILED', 'DURABLE_RESPONSE_MALFORMED'],
    );
    assert.equal(metadata.record['list_complete'], true);
  });

  it('stops a history whose marker repeats', async () => {
    const reader = new ScriptedDurableExecutionReader();
    reader.addExecution(sdkExecution(1, 'SUCCEEDED'), [sdkEvent('ExecutionStarted', 1)]);
    reader.scriptRepeatedMarker('historyPage');
    const metadata = await collectDurableExecutionMetadata(reader, REQUEST, TRIAL_SCOPE, collectionClock());
    assert.equal(executionsOf(metadata.record)[0]?.['history_complete'], false);
  });
});

describe('buildDurableExecutionMetadata', () => {
  it('builds the record from what was read', () => {
    const record = buildDurableExecutionMetadata({
      scope: TRIAL_SCOPE,
      request: REQUEST,
      captured_at: '2026-10-05T12:20:00.000Z' as UtcMillis,
      list_complete: false,
      executions: [],
    });
    assertValidRecord(record);
    assert.equal(record['function_arn'], DURABLE_FUNCTION_ARN);
    assert.equal(record['list_complete'], false);
  });
});
