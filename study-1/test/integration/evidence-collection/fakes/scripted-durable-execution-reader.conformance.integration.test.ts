// Conformance of ScriptedDurableExecutionReader (design §12.2): for the same executions, the
// metadata the collector builds through it equals what it builds through the real Lambda binding
// over a real LambdaClient — listing, detail and history, paged — and an unknown execution fails
// with the same code. Scripted failures and the repeated marker have no real counterpart: they
// emulate a service that fails one call or a broken endpoint that never advances.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLambdaDurableExecutionReader } from '../../../../src/evidence-collection/aws/durable-execution-reader.ts';
import { collectDurableExecutionMetadata } from '../../../../src/evidence-collection/durable-metadata.ts';
import type {
  DurableExecutionReader,
  DurableListingRequest,
} from '../../../../src/evidence-collection/durable-metadata.ts';
import type { SdkDurableExecution, SdkHistoryEvent } from '../../../../src/evidence-collection/durable-sdk-mapping.ts';
import type { JsonObject, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import {
  collectionClock,
  DURABLE_FUNCTION_ARN,
  TRIAL_SCOPE,
} from '../../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedDurableExecutionClient } from '../../../support/evidence-collection/scripted-durable-execution-client.ts';
import type { ModelledDurableExecution } from '../../../support/evidence-collection/scripted-durable-execution-client.ts';
import { ScriptedDurableExecutionReader } from '../../../support/evidence-collection/scripted-durable-execution-reader.ts';

const STARTED_MS = Date.UTC(2026, 9, 5, 12, 5, 1);
const REQUEST: DurableListingRequest = {
  function_arn: DURABLE_FUNCTION_ARN,
  qualifier: '3',
  started_after: '2026-10-05T12:05:00.000Z' as UtcMillis,
};

interface Execution {
  readonly serial: number;
  readonly status: ModelledDurableExecution['status'];
  readonly events: readonly string[];
}

const FIRST_EXECUTION: Execution = {
  serial: 1,
  status: 'SUCCEEDED',
  events: ['ExecutionStarted', 'StepStarted', 'StepSucceeded', 'ExecutionSucceeded'],
};

const EXECUTIONS: readonly Execution[] = [
  FIRST_EXECUTION,
  { serial: 2, status: 'RUNNING', events: ['ExecutionStarted'] },
  { serial: 3, status: 'FAILED', events: [] },
];

function arnOf(serial: number): string {
  return `${DURABLE_FUNCTION_ARN}:3/durable-execution/exec-${String(serial)}/run`;
}

function endedMs(execution: Execution): number | undefined {
  return execution.status === 'RUNNING' ? undefined : STARTED_MS + execution.serial * 1000 + 500;
}

function modelled(execution: Execution): ModelledDurableExecution {
  const ended = endedMs(execution);
  return {
    arn: arnOf(execution.serial),
    name: `exec-${String(execution.serial)}`,
    function_arn: DURABLE_FUNCTION_ARN,
    qualifier: '3',
    status: execution.status,
    started_ms: STARTED_MS + execution.serial * 1000,
    ...(ended === undefined ? {} : { ended_ms: ended }),
    version: '3',
    history: execution.events.map((type, index) => ({
      EventType: type,
      EventId: index + 1,
      EventTimestamp: (STARTED_MS + execution.serial * 1000 + index) / 1000,
    })),
  };
}

function sdkListed(execution: Execution): SdkDurableExecution {
  const ended = endedMs(execution);
  return {
    DurableExecutionArn: arnOf(execution.serial),
    DurableExecutionName: `exec-${String(execution.serial)}`,
    Status: execution.status,
    StartTimestamp: new Date(STARTED_MS + execution.serial * 1000),
    ...(ended === undefined ? {} : { EndTimestamp: new Date(ended) }),
    Version: '3',
  };
}

function sdkHistory(execution: Execution): readonly SdkHistoryEvent[] {
  return execution.events.map((type, index) => ({
    EventType: type,
    EventId: index + 1,
    EventTimestamp: new Date(STARTED_MS + execution.serial * 1000 + index),
  }));
}

function bothReaders(pageSize: number): {
  readonly fake: ScriptedDurableExecutionReader;
  readonly real: DurableExecutionReader;
} {
  const fake = new ScriptedDurableExecutionReader(pageSize);
  const lambda = new ScriptedDurableExecutionClient(pageSize);
  for (const execution of EXECUTIONS) {
    fake.addExecution(sdkListed(execution), sdkHistory(execution));
    lambda.addExecution(modelled(execution));
  }
  return { fake, real: createLambdaDurableExecutionReader(lambda.client) };
}

async function metadataOf(reader: DurableExecutionReader): Promise<JsonObject> {
  return (await collectDurableExecutionMetadata(reader, REQUEST, TRIAL_SCOPE, collectionClock())).record;
}

describe('ScriptedDurableExecutionReader conformance', () => {
  for (const pageSize of [1, 2, 100]) {
    it(`yields the metadata the real binding yields, in pages of ${String(pageSize)}`, async () => {
      const { fake, real } = bothReaders(pageSize);
      assert.deepEqual(await metadataOf(fake), await metadataOf(real));
    });
  }

  it('fails an unknown execution with the real binding code', async () => {
    const { fake, real } = bothReaders(100);
    assert.deepEqual(await fake.getExecution('arn:missing'), await real.getExecution('arn:missing'));
    assert.deepEqual(await fake.historyPage('arn:missing'), await real.historyPage('arn:missing'));
  });

  it('fails the next calls of one operation with the scripted codes, in order', async () => {
    const fake = new ScriptedDurableExecutionReader();
    fake.addExecution(sdkListed(FIRST_EXECUTION), []);
    fake.scriptFailure('getExecution', 'First');
    fake.scriptFailure('getExecution', 'Second');
    assert.deepEqual(await fake.getExecution(arnOf(1)), { ok: false, error: { code: 'First' } });
    assert.deepEqual(await fake.getExecution(arnOf(1)), { ok: false, error: { code: 'Second' } });
    assert.equal((await fake.getExecution(arnOf(1))).ok, true);
    fake.scriptFailure('listPage', 'Throttled');
    fake.scriptFailure('historyPage', 'Throttled');
    assert.deepEqual(await fake.listPage(REQUEST), { ok: false, error: { code: 'Throttled' } });
    assert.deepEqual(await fake.historyPage(arnOf(1)), { ok: false, error: { code: 'Throttled' } });
    assert.deepEqual(fake.listingRequests(), [REQUEST]);
  });

  it('a scripted repeated marker answers each page with the marker it was asked with', async () => {
    const fake = new ScriptedDurableExecutionReader(1);
    fake.addExecution(sdkListed(FIRST_EXECUTION), sdkHistory(FIRST_EXECUTION));
    fake.scriptRepeatedMarker('listPage');
    const first = await fake.listPage(REQUEST);
    assert.ok(first.ok);
    assert.equal(first.value.NextMarker, 'loop');
    const again = await fake.listPage(REQUEST, 'loop');
    assert.ok(again.ok);
    assert.equal(again.value.NextMarker, 'loop');
  });

  it('an empty page carries no list member, which the SDK leaves undefined', async () => {
    const fake = new ScriptedDurableExecutionReader();
    assert.deepEqual(await fake.listPage(REQUEST), { ok: true, value: { NextMarker: undefined } });
  });
});
