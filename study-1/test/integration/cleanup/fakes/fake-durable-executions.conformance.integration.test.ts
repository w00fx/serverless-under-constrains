// Conformance of FakeDurableExecutions (RK-10) to the DurableExecutionPort contract: listing
// returns only RUNNING executions of the function, sorted; stopping a running execution ends
// it and removes it from the durable_executions surface; stopping an ended one is not_running;
// scripted failures are values.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STACK_ID } from '../../../support/cleanup/cleanup-fixtures.ts';
import { FakeDurableExecutions } from '../../../support/cleanup/fake-durable-executions.ts';
import { StubDiscoverySurfaces } from '../../../support/cleanup/stub-discovery-surfaces.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

function rig(): {
  readonly surfaces: StubDiscoverySurfaces;
  readonly executions: FakeDurableExecutions;
  readonly log: RecordingMutationLog;
} {
  const surfaces = new StubDiscoverySurfaces();
  const log = new RecordingMutationLog();
  return { surfaces, log, executions: new FakeDurableExecutions(surfaces, log, STACK_ID) };
}

describe('FakeDurableExecutions conformance', () => {
  it('lists running executions per function and mirrors them on the surface', async () => {
    const { surfaces, executions } = rig();
    executions.start('fn', 'arn:2');
    executions.start('fn', 'arn:1');
    executions.start('other', 'arn:3');
    assert.deepEqual(await executions.listRunning('fn'), { ok: true, running_execution_arns: ['arn:1', 'arn:2'] });
    const listed = await surfaces.query('durable_executions');
    assert.deepEqual(
      listed.ok
        ? listed.resources.map((resource) => [resource.identifier, resource.managed_by_stack_id, resource.tags.kind])
        : [],
      [
        ['arn:2', STACK_ID, 'untaggable'],
        ['arn:1', STACK_ID, 'untaggable'],
        ['arn:3', STACK_ID, 'untaggable'],
      ],
    );
    assert.equal(executions.runningCount(), 3);
  });

  it('stops a running execution once; a second stop finds it not running', async () => {
    const { surfaces, executions, log } = rig();
    executions.start('fn', 'arn:1');
    assert.deepEqual(await executions.stop('arn:1'), { kind: 'stopped' });
    assert.deepEqual(await executions.stop('arn:1'), { kind: 'not_running' });
    assert.equal(executions.runningCount(), 0);
    assert.deepEqual(await surfaces.query('durable_executions'), { ok: true, resources: [] });
    assert.equal(log.entries().filter((entry) => entry.operation === 'StopDurableExecution').length, 2);
  });

  it('ends an execution right after listing it when scripted', async () => {
    const { executions } = rig();
    executions.start('fn', 'arn:1');
    executions.endAfterListing('arn:1');
    assert.deepEqual(await executions.listRunning('fn'), { ok: true, running_execution_arns: ['arn:1'] });
    assert.equal(executions.runningCount(), 0);
    assert.deepEqual(await executions.stop('arn:1'), { kind: 'not_running' });
  });

  it('fails scripted listings and stops as values', async () => {
    const { executions } = rig();
    executions.start('fn', 'arn:1');
    executions.failList('fn');
    executions.failStop('arn:1');
    assert.equal((await executions.listRunning('fn')).ok, false);
    assert.equal((await executions.stop('arn:1')).kind, 'failed');
    assert.equal(executions.runningCount(), 1);
  });
});
