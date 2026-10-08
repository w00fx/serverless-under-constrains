// Step 9 against the fake stack and stubbed surfaces (BR-RUA-048 step 9, BR-RUA-050, RK-10):
// stack deletion by recorded id and its failure modes, direct deletion of proven owned
// resources only, the stack-boundary rule, and reconciliation of earlier failed deletions.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deleteOwnedResources,
  STACK_DELETE_MAX_POLLS,
  STACK_DELETE_POLL_INTERVAL_MS,
} from '../../../src/cleanup/owned-resource-deletion.ts';
import type { OwnershipContext } from '../../../src/cleanup/ownership-context.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import {
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import type { ItemAction, StepOutcome } from '../../../src/cleanup/step-recording.ts';
import type { CleanupResource } from '../../../src/record-contract/records/group-c/cleanup_result.ts';
import {
  discovered,
  NAMES,
  ownershipContext,
  resourceManifest,
  STACK_ID,
  STACK_MEMBERS,
} from '../../support/cleanup/cleanup-fixtures.ts';
import type { CleanupWorld } from '../../support/cleanup/cleanup-harness.ts';
import { cleanupWorld } from '../../support/cleanup/cleanup-harness.ts';

const TABLE_KEY = resourceKey({ resource_type: TABLE_RESOURCE_TYPE, identifier: NAMES.controlTable });

interface StepRun {
  readonly outcome: StepOutcome;
  readonly items: readonly string[];
}

async function runStep9(
  world: CleanupWorld,
  ownership: OwnershipContext = ownershipContext(),
  earlier: readonly CleanupResource[] = [],
): Promise<StepRun> {
  const items: ItemAction[] = [];
  const outcome = await deleteOwnedResources(
    ownership,
    { stacks: world.stack, surfaces: world.surfaces, deleter: world.deleter, sleeper: world.sleeper },
    earlier,
    (item) => {
      items.push(item);
      return Promise.resolve();
    },
  );
  return {
    outcome,
    items: items.map((item) => `${item.action} ${item.ownership_basis ?? '-'} ${item.resource_identifier}`),
  };
}

function codes(outcome: StepOutcome): readonly string[] {
  return outcome.reasons.map((reason) => reason.code);
}

describe('deleteOwnedResources: the recorded stack', () => {
  it('deletes the stack by id and waits for DELETE_COMPLETE', async () => {
    const world = cleanupWorld();
    const run = await runStep9(world);
    assert.deepEqual(run.outcome, { status: 'succeeded', reasons: [] });
    assert.deepEqual(run.items, [`DELETED recorded_stack ${STACK_ID}`]);
    assert.equal(world.stack.status(), 'DELETE_COMPLETE');
    assert.deepEqual(world.sleeper.requests(), [STACK_DELETE_POLL_INTERVAL_MS]);
  });

  it('counts a stack that reads absent after the request as deleted', async () => {
    const world = cleanupWorld();
    world.stack.forgetDeletedStack();
    const run = await runStep9(world);
    assert.deepEqual(run.outcome, { status: 'succeeded', reasons: [] });
    assert.deepEqual(run.items, [`DELETED recorded_stack ${STACK_ID}`]);
    assert.deepEqual(world.sleeper.requests(), [STACK_DELETE_POLL_INTERVAL_MS]);
  });

  it('reports a refused deletion request and still sweeps the remaining resources', async () => {
    const world = cleanupWorld();
    world.stack.failDeleteRequests();
    const run = await runStep9(world);
    assert.equal(run.outcome.status, 'failed');
    assert.deepEqual(codes(run.outcome), ['ValidationError']);
    assert.equal(world.deleter.requests().length, STACK_MEMBERS.length, 'every member is proven owned on its own');
    assert.equal(run.items[0], `DELETE_FAILED recorded_stack ${STACK_ID}`);
    assert.ok(run.items.includes(`DELETED resource_manifest_and_tags ${NAMES.controlTable}`), run.items.join('\n'));
  });

  it('reports DELETE_FAILED and deletes the retained members it may delete itself', async () => {
    const world = cleanupWorld();
    world.stack.failDeletionRetaining([TABLE_KEY]);
    const run = await runStep9(world);
    assert.deepEqual(codes(run.outcome), ['STACK_DELETE_FAILED']);
    assert.match(
      run.outcome.reasons[0]?.detail ?? '',
      /stack deletion ended with status DELETE_FAILED; expected DELETE_COMPLETE/,
    );
    assert.deepEqual(run.items, [
      `DELETE_FAILED recorded_stack ${STACK_ID}`,
      `DELETED resource_manifest_and_tags ${NAMES.controlTable}`,
    ]);
  });

  it('times out while a running durable execution blocks the deletion (RK-10)', async () => {
    const world = cleanupWorld();
    world.executions.start(NAMES.durableFunction, 'arn:durable/1');
    const run = await runStep9(world);
    assert.equal(world.stack.blockedReads(), STACK_DELETE_MAX_POLLS);
    assert.equal(world.sleeper.requests().length, STACK_DELETE_MAX_POLLS);
    assert.equal(run.outcome.reasons[0]?.code, 'STACK_DELETE_TIMED_OUT');
    assert.match(run.outcome.reasons[0].detail, /status "DELETE_IN_PROGRESS" after 240 reads/);
    assert.ok(
      run.items.includes(`DELETE_FAILED recorded_stack arn:durable/1`),
      'the execution is owned only through the stack',
    );
    assert.equal(world.executions.runningCount(), 1, 'cleanup never deletes it directly');
  });

  it('times out on a stack it can no longer read', async () => {
    const world = cleanupWorld();
    world.stack.failDescribe();
    const run = await runStep9(world);
    assert.equal(run.outcome.reasons[0]?.code, 'STACK_DELETE_TIMED_OUT');
    assert.match(run.outcome.reasons[0].detail, /an unreadable stack \(ValidationError\) after 240 reads/);
  });

  it('records an absent stack as already absent without a deletion request', async () => {
    const world = cleanupWorld({ stackExists: false });
    const run = await runStep9(world);
    assert.deepEqual(run.items, [`ALREADY_ABSENT recorded_stack ${STACK_ID}`]);
    assert.equal(world.log.firstSequenceOf('cloudformation', 'DeleteStack'), undefined);
  });

  it('touches no stack when the manifest recorded none', async () => {
    const world = cleanupWorld({ stackExists: false });
    const orphan = discovered(LOG_GROUP_RESOURCE_TYPE, `/aws/lambda/${NAMES.providerFunction}`, 'log_groups');
    world.surfaces.place(orphan);
    const run = await runStep9(world, ownershipContext(resourceManifest('partial', { withStack: false, members: [] })));
    assert.deepEqual(run.items, [`DELETED tags_name_type_created_after_freeze ${orphan.identifier}`]);
    assert.equal(world.log.firstSequenceOf('cloudformation', 'DeleteStack'), undefined);
  });
});

describe('deleteOwnedResources: remaining resources', () => {
  it('fails a resource owned only through the stack that outlives the stack, without deleting it', async () => {
    const world = cleanupWorld({ stackExists: false });
    const listed = discovered(QUEUE_RESOURCE_TYPE, NAMES.durableDlqUrl, 'stack_resources', {
      tags: { kind: 'untaggable' },
      managed_by_stack_id: STACK_ID,
    });
    world.surfaces.place(listed);
    const run = await runStep9(world);
    assert.deepEqual(codes(run.outcome), ['STACK_BOUNDARY_RESOURCE_REMAINS']);
    assert.match(
      run.outcome.reasons[0]?.detail ?? '',
      /still observed on stack_resources; expected the stack deletion to remove it/,
    );
    assert.deepEqual(world.deleter.requests(), []);
  });

  it('records a direct deletion failure and keeps going', async () => {
    const world = cleanupWorld({ stackExists: false });
    world.surfaces.place(
      discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables'),
      discovered(LOG_GROUP_RESOURCE_TYPE, NAMES.providerLogGroup, 'log_groups'),
    );
    world.deleter.failFor(NAMES.controlTable);
    const run = await runStep9(world);
    assert.deepEqual(codes(run.outcome), ['ResourceInUseException']);
    assert.deepEqual(run.items.slice(1), [
      `DELETE_FAILED resource_manifest_and_tags ${NAMES.controlTable}`,
      `DELETED resource_manifest_and_tags ${NAMES.providerLogGroup}`,
    ]);
  });

  it('fails the step when a surface cannot be read', async () => {
    const world = cleanupWorld();
    world.surfaces.failQuery('roles');
    const run = await runStep9(world);
    assert.deepEqual(codes(run.outcome), ['ThrottlingException']);
  });
});

describe('deleteOwnedResources: earlier failed deletions', () => {
  const earlierTable: CleanupResource = {
    resource_type: TABLE_RESOURCE_TYPE,
    resource_identifier: NAMES.controlTable,
    ownership_basis: 'resource_manifest_and_tags',
    action: 'DELETE_FAILED',
    reasons: [],
  };
  const earlierStack: CleanupResource = {
    ...earlierTable,
    resource_type: STACK_RESOURCE_TYPE,
    resource_identifier: STACK_ID,
    ownership_basis: 'recorded_stack',
  };

  it('records one no surface observes any more as already absent', async () => {
    const world = cleanupWorld({
      members: STACK_MEMBERS.filter((member) => member.resource_type !== TABLE_RESOURCE_TYPE),
    });
    const run = await runStep9(world, ownershipContext(), [earlierStack, earlierTable]);
    assert.deepEqual(run.items, [
      `DELETED recorded_stack ${STACK_ID}`,
      `ALREADY_ABSENT resource_manifest_and_tags ${NAMES.controlTable}`,
    ]);
  });

  it('acts again on one still observed, and leaves it alone when a surface failed', async () => {
    const world = cleanupWorld({ stackExists: false });
    world.surfaces.place(discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables'));
    const run = await runStep9(world, ownershipContext(), [earlierTable]);
    assert.deepEqual(run.items.slice(1), [`DELETED resource_manifest_and_tags ${NAMES.controlTable}`]);

    const failing = cleanupWorld({ stackExists: false });
    failing.surfaces.failQuery('tables');
    const blind = await runStep9(failing, ownershipContext(), [earlierTable]);
    assert.deepEqual(blind.items, [`ALREADY_ABSENT recorded_stack ${STACK_ID}`]);
  });
});
