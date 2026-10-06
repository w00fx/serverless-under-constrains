// AC-RUA-011 Verifiable Cleanup (BR-RUA-048, -049, -050, -051; design §14 row 011): cleanup
// against stubbed discovery surfaces after an execution that succeeded, failed, became
// indeterminate or was interrupted; cleanup run twice; resources already absent; an ambiguously
// owned resource reported and never deleted; and RK-10, durable executions stopped before the
// stack deletion they would block.
//
// Each case runs the real orchestrator, leak auditor, ownership rules, safety release (over the
// in-memory control table) and journal writer (over an in-memory JSONL file); only the AWS
// surfaces are fakes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { logGroupName } from '../../../infra/ownership/resource-naming.ts';
import { leakCompromisesIsolation } from '../../../src/cleanup/leak-capability.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import {
  FUNCTION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import { assertConsistentOutcome, resourceActions, stepStatuses } from '../../support/cleanup/cleanup-assertions.ts';
import {
  discovered,
  EXECUTION_ID,
  NAMES,
  ownershipContext,
  resourceManifest,
  STACK_ID,
  STACK_MEMBERS,
  tagged,
} from '../../support/cleanup/cleanup-fixtures.ts';
import {
  cleanupInput,
  cleanupOrchestrator,
  cleanupWorld,
  journalHistory,
  seedTreatment,
  TREATMENT_PARTITION,
} from '../../support/cleanup/cleanup-harness.ts';

const STACK_ENTRY = `${STACK_RESOURCE_TYPE} ${STACK_ID}`;
const TABLE_KEY = resourceKey({ resource_type: TABLE_RESOURCE_TYPE, identifier: NAMES.controlTable });
const DURABLE_ARN = `arn:aws:lambda:us-east-1:123456789012:function:${NAMES.durableFunction}:1/durable-execution/run-1/0001`;
const ALL_STEPS_SUCCEEDED = {
  1: 'succeeded',
  2: 'succeeded',
  3: 'succeeded',
  4: 'succeeded',
  5: 'succeeded',
  6: 'succeeded',
  7: 'succeeded',
  8: 'succeeded',
  9: 'succeeded',
  10: 'succeeded',
  11: 'succeeded',
  12: 'started',
};

describe('AC-RUA-011 verifiable cleanup', () => {
  it('succeeded', async () => {
    const world = cleanupWorld();
    seedTreatment(world, 'RESPONSE_RELEASED');
    world.dlq.add('m-captured', 'm-uncaptured');
    world.evidence.captureMessages('m-captured');

    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));

    assertConsistentOutcome(world, outcome);
    const result = outcome.cleanup_result;
    assert.equal(result.cleanup_status, 'succeeded');
    assert.equal(result.cleanup_mode, 'NORMAL');
    assert.deepEqual(stepStatuses(result), ALL_STEPS_SUCCEEDED);
    assert.deepEqual(resourceActions(result), { [STACK_ENTRY]: 'DELETED/recorded_stack' });
    assert.deepEqual(world.deleter.requests(), [], 'the stack deletion removed every member');
    assert.deepEqual(result.deleted_dlq_message_ids, ['m-captured']);
    assert.deepEqual(world.dlq.requested(), ['m-captured'], 'an uncaptured message is never deleted');
    assert.deepEqual(world.dlq.remaining(), ['m-uncaptured']);
    assert.equal(world.consumers.stateOf(NAMES.sourceMapping), 'Disabled');
    assert.equal(
      world.store.peek('control', { pk: TREATMENT_PARTITION, sk: 'treatment' })?.['state'],
      'RESPONSE_RELEASED',
    );
    assert.equal(result.duration_breach, false);
    const audit = outcome.leak_audit_result;
    assert.equal(audit.leak_audit_status, 'clean');
    assert.equal(audit.passes.length, 2);
    assert.ok(audit.stable_absence_interval_ms >= 120_000);
  });

  it('failed', async () => {
    // Provisioning failed midway: the partial manifest recorded three members, the account holds
    // all seven plus a run-tagged log group with the run's deterministic name that no stack lists
    // any more (retained by the rollback, [R-aws] §6.3 DELETE_SKIPPED). Lambda's own
    // `/aws/lambda/<function>` group would be untagged ([R-aws] §6.2), so it could not stand here:
    // nothing would prove it owned, and it would be ambiguous instead.
    const world = cleanupWorld();
    const retainedLogGroup = logGroupName(EXECUTION_ID, 'durable-caller');
    world.surfaces.place(
      discovered(LOG_GROUP_RESOURCE_TYPE, retainedLogGroup, 'log_groups'),
      discovered(LOG_GROUP_RESOURCE_TYPE, retainedLogGroup, 'tag_index'),
    );
    const ownership = ownershipContext(resourceManifest('partial', { members: STACK_MEMBERS.slice(0, 3) }));

    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world, ownership));

    assertConsistentOutcome(world, outcome);
    assert.equal(outcome.cleanup_result.cleanup_status, 'succeeded');
    assert.deepEqual(resourceActions(outcome.cleanup_result), {
      [STACK_ENTRY]: 'DELETED/recorded_stack',
      [`${LOG_GROUP_RESOURCE_TYPE} ${retainedLogGroup}`]: 'DELETED/tags_name_type_created_after_freeze',
    });
    assert.deepEqual(
      world.deleter.requests().map((resource) => resource.identifier),
      [retainedLogGroup],
    );
    assert.equal(outcome.leak_audit_result.leak_audit_status, 'clean');
  });

  it('indeterminate', async () => {
    // The trial ended indeterminate: its barrier is still held and a durable caller still runs.
    const world = cleanupWorld();
    seedTreatment(world, 'COMMITTED_WAITING');
    world.executions.start(NAMES.durableFunction, DURABLE_ARN);
    world.dlq.add('m-1');
    world.evidence.captureMessages('m-1');

    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));

    assertConsistentOutcome(world, outcome);
    const treatment = world.store.peek('control', { pk: TREATMENT_PARTITION, sk: 'treatment' });
    assert.deepEqual(
      { state: treatment?.['state'], cause: treatment?.['safety_release_cause'], version: treatment?.['version'] },
      { state: 'SAFETY_RELEASED', cause: 'CLEANUP_REQUEST', version: 4 },
    );
    const induced = journalHistory(world)
      .entries.filter((entry) => entry.body.cleanup_induced)
      .map((entry) => [entry.body.step, entry.body.action, entry.body.resource_identifier]);
    assert.deepEqual(induced, [
      [6, 'TREATMENT_SAFETY_RELEASED', TREATMENT_PARTITION],
      [6, 'DURABLE_EXECUTION_STOPPED', DURABLE_ARN],
    ]);
    assert.deepEqual(outcome.cleanup_result.stopped_durable_execution_arns, [DURABLE_ARN]);
    assert.deepEqual(outcome.cleanup_result.deleted_dlq_message_ids, ['m-1']);
    assert.equal(outcome.cleanup_result.cleanup_status, 'succeeded');
    assert.equal(outcome.leak_audit_result.leak_audit_status, 'clean');
  });

  it('interrupted', async () => {
    // An interrupted execution gets emergency cleanup, past the total-time target; the stack
    // deletion fails and the stack survives as a processing-capable leak.
    const world = cleanupWorld();
    world.stack.failDeletionRetaining([TABLE_KEY]);
    world.safety.exceed();

    const outcome = await cleanupOrchestrator(world).runEmergency(cleanupInput(world));

    assertConsistentOutcome(world, outcome);
    const result = outcome.cleanup_result;
    assert.equal(result.cleanup_mode, 'EMERGENCY');
    assert.equal(journalHistory(world).entries[0]?.body.step, 3, 'consumers stop first');
    assert.deepEqual(
      world.evidence.calls().map((call) => `${call.operation}:${call.mode ?? '-'}`),
      ['cutoff:EMERGENCY', 'assessment:EMERGENCY', 'snapshot:EMERGENCY', 'dlq:EMERGENCY', 'freeze:-'],
    );
    assert.equal(result.cleanup_status, 'partial');
    assert.equal(result.duration_breach, true);
    assert.deepEqual(resourceActions(result), {
      [STACK_ENTRY]: 'DELETE_FAILED/recorded_stack',
      [`${TABLE_RESOURCE_TYPE} ${NAMES.controlTable}`]: 'DELETED/resource_manifest_and_tags',
    });
    const audit = outcome.leak_audit_result;
    assert.equal(audit.leak_audit_status, 'leaks_detected');
    assert.deepEqual(
      audit.leaks.map((leak) => [leak.resource_type, leak.capability_class, leak.ownership_basis]),
      [[STACK_RESOURCE_TYPE, 'processing_capable', 'recorded_stack']],
    );
    assert.ok(audit.leaks.every(leakCompromisesIsolation));
    assert.equal(stepStatuses(result)[11], 'failed');
  });

  it('run-twice', async () => {
    // Run 1 cannot delete the stack or the table; run 2 retries the stack, whose deletion now
    // removes the table, and repeats none of the steps that already succeeded.
    const world = cleanupWorld();
    world.stack.failDeletionRetaining([TABLE_KEY]);
    world.deleter.failFor(NAMES.controlTable);
    world.evidence.captureMessages('m-1');
    world.dlq.add('m-1');

    const first = await cleanupOrchestrator(world, 1).runNormal(cleanupInput(world));
    assert.equal(first.cleanup_result.cleanup_status, 'partial');
    assert.equal(first.leak_audit_result.leak_audit_status, 'leaks_detected');

    const second = await cleanupOrchestrator(world, 2).runNormal(cleanupInput(world));

    assertConsistentOutcome(world, second);
    const result = second.cleanup_result;
    assert.equal(result.cleanup_status, 'succeeded');
    assert.deepEqual(resourceActions(result), {
      [STACK_ENTRY]: 'DELETED/recorded_stack',
      [`${TABLE_RESOURCE_TYPE} ${NAMES.controlTable}`]: 'ALREADY_ABSENT/resource_manifest_and_tags',
    });
    assert.deepEqual(stepStatuses(result), ALL_STEPS_SUCCEEDED);
    assert.equal(result.started_at, first.cleanup_result.started_at, 'the result spans both runs');
    assert.deepEqual(
      world.evidence.calls().map((call) => call.operation),
      ['cutoff', 'assessment', 'snapshot', 'dlq', 'freeze', 'freeze'],
      'only the audit and the freeze run again',
    );
    assert.deepEqual(world.dlq.requested(), ['m-1']);
    assert.equal(world.log.entries().filter((entry) => entry.operation === 'UpdateEventSourceMapping').length, 1);
    assert.equal(world.log.entries().filter((entry) => entry.operation === 'DeleteStack').length, 2);
    assert.equal(second.leak_audit_result.leak_audit_status, 'clean');
  });

  it('already-absent', async () => {
    // The stack and the consumer are already gone; a table listing still lags behind its
    // deletion; the captured DLQ message was already deleted.
    const world = cleanupWorld({ stackExists: false });
    world.surfaces.place(discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables'));
    world.surfaces.lagAbsence(TABLE_KEY, 1);
    world.surfaces.remove(TABLE_KEY);
    world.evidence.captureMessages('m-gone');

    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));

    assertConsistentOutcome(world, outcome);
    const result = outcome.cleanup_result;
    assert.equal(result.cleanup_status, 'succeeded');
    assert.deepEqual(resourceActions(result), {
      [STACK_ENTRY]: 'ALREADY_ABSENT/recorded_stack',
      [`${TABLE_RESOURCE_TYPE} ${NAMES.controlTable}`]: 'ALREADY_ABSENT/resource_manifest_and_tags',
    });
    assert.deepEqual(result.deleted_dlq_message_ids, ['m-gone']);
    assert.equal(world.log.firstSequenceOf('cloudformation', 'DeleteStack'), undefined);
    const consumerActions = journalHistory(world)
      .entries.filter((entry) => entry.body.step === 3 && entry.body.resource_identifier !== undefined)
      .map((entry) => entry.body.action);
    assert.deepEqual(consumerActions, ['CONSUMER_ALREADY_ABSENT']);
    assert.equal(outcome.leak_audit_result.leak_audit_status, 'clean');
  });

  it('ambiguous-never-deleted', async () => {
    // A function with a run-like name that carries only the generic project tag, and the CDK
    // bootstrap stack, both seen next to the run's infrastructure.
    const world = cleanupWorld();
    const stray = `${NAMES.providerFunction}-stray`;
    const projectOnly = tagged([{ key: 'suc:project', value: 'serverless-under-constraints' }]);
    const bootstrap =
      'arn:aws:cloudformation:us-east-1:123456789012:stack/CDKToolkit/0f0e0d0c-0000-4000-8000-0000000000b0';
    world.surfaces.place(
      discovered(FUNCTION_RESOURCE_TYPE, stray, 'functions', { tags: projectOnly }),
      discovered(FUNCTION_RESOURCE_TYPE, stray, 'tag_index', { tags: projectOnly }),
      discovered(STACK_RESOURCE_TYPE, bootstrap, 'stack'),
    );

    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));

    assertConsistentOutcome(world, outcome);
    const requested = world.deleter.requests().map((resource) => resource.identifier);
    assert.ok(!requested.includes(stray) && !requested.includes(bootstrap), `deleted ${JSON.stringify(requested)}`);
    assert.ok(world.surfaces.isPresent(resourceKey({ resource_type: FUNCTION_RESOURCE_TYPE, identifier: stray })));
    const result = outcome.cleanup_result;
    assert.deepEqual(resourceActions(result), {
      [STACK_ENTRY]: 'DELETED/recorded_stack',
      [`${FUNCTION_RESOURCE_TYPE} ${stray}`]: 'SKIPPED_AMBIGUOUS/ambiguous',
      [`${STACK_RESOURCE_TYPE} ${bootstrap}`]: 'EXCLUDED_BASELINE/excluded_baseline',
    });
    const skipped = result.resources.find((resource) => resource.resource_identifier === stray);
    assert.deepEqual(
      skipped?.reasons.map((reason) => reason.code),
      ['NOT_IN_COMPLETE_MANIFEST', 'RUN_TAGS_NOT_PROVEN'],
    );
    assert.equal(result.cleanup_status, 'succeeded', 'an ambiguous resource is not a failed deletion');
    const audit = outcome.leak_audit_result;
    assert.equal(audit.leak_audit_status, 'inconclusive');
    assert.deepEqual(audit.leaks, []);
    assert.deepEqual(
      audit.ambiguous.map((entry) => entry.identifier),
      [stray],
    );
  });

  it('durable-stopped-before-stack-delete', async () => {
    const world = cleanupWorld();
    world.executions.start(NAMES.durableFunction, DURABLE_ARN);

    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));

    assertConsistentOutcome(world, outcome);
    const stopped = world.log.firstSequenceOf('lambda', 'StopDurableExecution');
    const deleted = world.log.firstSequenceOf('cloudformation', 'DeleteStack');
    assert.ok(
      stopped !== undefined && deleted !== undefined && stopped < deleted,
      `stop ${String(stopped)}, delete ${String(deleted)}`,
    );
    assert.equal(world.stack.blockedReads(), 0, 'no running execution blocked the stack deletion');
    assert.equal(world.executions.runningCount(), 0);
    assert.deepEqual(outcome.cleanup_result.stopped_durable_execution_arns, [DURABLE_ARN]);
    assert.equal(outcome.cleanup_result.cleanup_status, 'succeeded');
    assert.equal(outcome.leak_audit_result.leak_audit_status, 'clean');
  });
});
