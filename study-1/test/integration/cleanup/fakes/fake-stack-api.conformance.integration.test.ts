// Conformance of FakeStackApi (design §12.2) to CloudFormation stack semantics cleanup relies
// on: a deletion request moves the stack to DELETE_IN_PROGRESS; it stays there while a durable
// execution runs (RK-10); DELETE_FAILED keeps the retained members and a retry deletes them;
// DELETE_COMPLETE removes the stack and its members; a deleted stack described by name fails
// while described by id it reads DELETE_COMPLETE; scripted failures are values.
//
// Sources (RK-17): [R-aws] §6.3, `DescribeStacks` needs the unique stack id for a deleted stack
// and `DELETE_SKIPPED`/retained resources stay to audit; [R-durable] §8 R8, deletion waits while a
// durable execution runs (up to 1 h).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resourceKey } from '../../../../src/cleanup/resource-names.ts';
import { STACK_RESOURCE_TYPE, TABLE_RESOURCE_TYPE } from '../../../../src/cleanup/resource-types.ts';
import {
  NAMES,
  runInfrastructure,
  STACK_ID,
  STACK_MEMBERS,
  STACK_NAME,
} from '../../../support/cleanup/cleanup-fixtures.ts';
import { FakeDurableExecutions } from '../../../support/cleanup/fake-durable-executions.ts';
import { FakeStackApi } from '../../../support/cleanup/fake-stack-api.ts';
import { StubDiscoverySurfaces } from '../../../support/cleanup/stub-discovery-surfaces.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

const TABLE_KEY = resourceKey({ resource_type: TABLE_RESOURCE_TYPE, identifier: NAMES.controlTable });
const STACK_KEY = resourceKey({ resource_type: STACK_RESOURCE_TYPE, identifier: STACK_ID });

interface StackRig {
  readonly surfaces: StubDiscoverySurfaces;
  readonly executions: FakeDurableExecutions;
  readonly stack: FakeStackApi;
  readonly log: RecordingMutationLog;
}

function rig(exists = true): StackRig {
  const surfaces = new StubDiscoverySurfaces();
  if (exists) {
    surfaces.place(...runInfrastructure());
  }
  const log = new RecordingMutationLog();
  const executions = new FakeDurableExecutions(surfaces, log, STACK_ID);
  const stack = new FakeStackApi(surfaces, executions, log, {
    stackId: STACK_ID,
    stackName: STACK_NAME,
    memberKeys: STACK_MEMBERS.map((member) => resourceKey(member)),
    exists,
  });
  return { surfaces, executions, stack, log };
}

describe('FakeStackApi conformance', () => {
  it('deletes the stack and its members on the read after the request', async () => {
    const { surfaces, stack, log } = rig();
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'present', status: 'CREATE_COMPLETE' });
    assert.deepEqual(await stack.requestDelete(STACK_ID), { kind: 'requested' });
    assert.equal(stack.status(), 'DELETE_IN_PROGRESS');
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'present', status: 'DELETE_COMPLETE' });
    assert.equal(surfaces.isPresent(STACK_KEY), false);
    assert.equal(surfaces.isPresent(TABLE_KEY), false);
    assert.equal((await stack.describe(STACK_NAME)).kind, 'failed', 'a deleted stack does not exist by name');
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'present', status: 'DELETE_COMPLETE' });
    assert.deepEqual(
      await stack.requestDelete(STACK_ID),
      { kind: 'requested' },
      'deleting a deleted stack id is a no-op',
    );
    assert.equal(stack.status(), 'DELETE_COMPLETE');
    assert.equal(log.entries().length, 2);
  });

  it('stays DELETE_IN_PROGRESS while a durable execution runs (RK-10)', async () => {
    const { executions, stack } = rig();
    executions.start('fn', 'arn:1');
    await stack.requestDelete(STACK_ID);
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'present', status: 'DELETE_IN_PROGRESS' });
    assert.equal(stack.blockedReads(), 1);
    await executions.stop('arn:1');
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'present', status: 'DELETE_COMPLETE' });
  });

  it('fails a deletion keeping the retained members, and a retry completes it', async () => {
    const { surfaces, stack } = rig();
    stack.failDeletionRetaining([TABLE_KEY]);
    await stack.requestDelete(STACK_ID);
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'present', status: 'DELETE_FAILED' });
    assert.equal(surfaces.isPresent(TABLE_KEY), true);
    assert.equal(surfaces.isPresent(STACK_KEY), true);
    assert.equal(surfaces.isPresent(resourceKey(STACK_MEMBERS[0] ?? { resource_type: '', identifier: '' })), false);
    await stack.requestDelete(STACK_ID);
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'present', status: 'DELETE_COMPLETE' });
    assert.equal(surfaces.isPresent(TABLE_KEY), false);
  });

  it('reads a never-created stack, or another stack, as absent', async () => {
    const { stack } = rig(false);
    assert.deepEqual(await stack.describe(STACK_ID), { kind: 'absent' });
    assert.deepEqual(await stack.requestDelete(STACK_ID), { kind: 'requested' });
    assert.equal(stack.status(), 'absent');
    assert.deepEqual(await rig().stack.describe('arn:other'), { kind: 'absent' });
  });

  it('fails scripted describes and deletion requests as values', async () => {
    const { stack } = rig();
    stack.failDeleteRequests();
    assert.equal((await stack.requestDelete(STACK_ID)).kind, 'failed');
    assert.equal(stack.status(), 'CREATE_COMPLETE');
    stack.failDescribe();
    assert.equal((await stack.describe(STACK_ID)).kind, 'failed');
  });
});
