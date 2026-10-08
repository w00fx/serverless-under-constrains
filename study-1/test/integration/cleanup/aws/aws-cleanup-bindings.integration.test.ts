// The AWS-bound cleanup ports of one execution (BR-RUA-048, BR-RUA-051, RK-10, AC-RUA-011), bound
// through the discovery targets of its resource manifest and run under the real orchestrator,
// leak auditor and journal writer against a scripted account: the mapping is disabled and the
// running durable execution stopped before the stack deletion, only the captured DLQ message is
// deleted, the audit comes back clean, and a second run finds everything already gone. A
// durable execution that cannot be stopped leaves the stack deletion failed, never succeeded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bindAwsCleanupPorts } from '../../../../src/cleanup/aws/aws-cleanup-bindings.ts';
import { CleanupOrchestrator } from '../../../../src/cleanup/cleanup-orchestrator.ts';
import { ControlTableBarrierRelease } from '../../../../src/cleanup/control-barrier-release.ts';
import { discoveryTargetsOf } from '../../../../src/cleanup/discovery-targets.ts';
import type { DiscoveryTargets } from '../../../../src/cleanup/discovery-targets.ts';
import { LeakAuditor } from '../../../../src/cleanup/leak-auditor.ts';
import { STACK_RESOURCE_TYPE } from '../../../../src/cleanup/resource-types.ts';
import { JournalWriter } from '../../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../../src/event-journal/jsonl-journal-port.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { liveRunManifest } from '../../../support/cleanup/aws/live-run-script.ts';
import { ScriptedRunAccount } from '../../../support/cleanup/aws/scripted-run-account.ts';
import { refuse, reply } from '../../../support/cleanup/aws/scripted-cleanup-endpoint.ts';
import { assertConsistentOutcome, resourceActions, stepStatuses } from '../../../support/cleanup/cleanup-assertions.ts';
import { EXECUTION, MANIFEST_SHA, ownershipContext, STACK_ID } from '../../../support/cleanup/cleanup-fixtures.ts';
import type { CleanupWorld } from '../../../support/cleanup/cleanup-harness.ts';
import {
  CLEANUP_JOURNAL_PATH,
  cleanupInput,
  cleanupWorld,
  seedTreatment,
} from '../../../support/cleanup/cleanup-harness.ts';

function liveTargets(): DiscoveryTargets {
  const targets = discoveryTargetsOf({ manifest: liveRunManifest(), execution: EXECUTION });
  if (!targets.ok) {
    throw new Error(`fixture manifest refused: ${targets.error.detail}; expected discovery targets`);
  }
  return targets.value;
}

// The real orchestrator over the AWS-bound ports, with the harness's journal, evidence, barrier
// release, sleeper and safety clock.
function awsOrchestrator(world: CleanupWorld, account: ScriptedRunAccount, run: number): CleanupOrchestrator {
  const ports = bindAwsCleanupPorts(account.endpoint.clients, liveTargets());
  const journal = new JournalWriter({
    port: createJsonlJournalPort(CLEANUP_JOURNAL_PATH, world.file),
    source: 'cleanup',
    instanceId: `cccccccc-0000-4000-8000-${String(run).padStart(12, '0')}` as Uuid4,
    scope: { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA, partition: { kind: 'execution' } },
    clock: world.time,
    ids: world.ids,
    maxDefinitiveRetries: 0,
  });
  return new CleanupOrchestrator({
    ...ports,
    journal,
    evidence: world.evidence,
    barriers: new ControlTableBarrierRelease(world.store),
    sleeper: world.sleeper,
    auditor: new LeakAuditor({
      surfaces: ports.surfaces,
      clock: world.time,
      monotonic: world.time,
      sleeper: world.sleeper,
    }),
    clock: world.time,
    safety: world.safety,
  });
}

function mutations(account: ScriptedRunAccount): readonly string[] {
  const mutating = /^(Update|Stop|Delete|ChangeMessageVisibility)/;
  return account.endpoint.calls().flatMap((call) => (mutating.test(call.operation) ? [call.operation] : []));
}

describe('AWS-bound cleanup ports under the orchestrator', () => {
  it('cleans a live run: consumers off and durable executions stopped before the stack is deleted', async () => {
    const world = cleanupWorld();
    seedTreatment(world, 'RESPONSE_RELEASED');
    const account = new ScriptedRunAccount();
    account.enqueueDlqMessage('m-captured');
    account.enqueueDlqMessage('m-uncaptured');
    world.evidence.captureMessages('m-captured');

    const outcome = await awsOrchestrator(world, account, 1).runNormal(
      cleanupInput(world, ownershipContext(liveRunManifest())),
    );

    assertConsistentOutcome(world, outcome);
    const result = outcome.cleanup_result;
    assert.equal(result.cleanup_status, 'succeeded', JSON.stringify(result.steps));
    assert.deepEqual(resourceActions(result), { [`${STACK_RESOURCE_TYPE} ${STACK_ID}`]: 'DELETED/recorded_stack' });
    assert.deepEqual(result.deleted_dlq_message_ids, ['m-captured']);
    assert.deepEqual(account.dlqMessageIds(), ['m-uncaptured']);
    assert.ok(account.stackDeleted());
    assert.deepEqual(mutations(account), [
      'UpdateEventSourceMapping',
      'StopDurableExecution',
      'DeleteMessage',
      'ChangeMessageVisibility',
      'DeleteStack',
    ]);
    assert.equal(outcome.leak_audit_result.leak_audit_status, 'clean');
    assert.ok(account.endpoint.calls().every((call) => call.region === 'us-east-1' || call.service === 'iam'));
  });

  it('runs twice: the second run finds the stack and every resource already gone', async () => {
    const world = cleanupWorld();
    seedTreatment(world, 'RESPONSE_RELEASED');
    const account = new ScriptedRunAccount();
    const ownership = ownershipContext(liveRunManifest());
    await awsOrchestrator(world, account, 1).runNormal(cleanupInput(world, ownership));
    const firstMutations = mutations(account).length;

    const second = await awsOrchestrator(world, account, 2).runNormal(cleanupInput(world, ownership));

    assertConsistentOutcome(world, second);
    assert.equal(second.cleanup_result.cleanup_status, 'succeeded', JSON.stringify(second.cleanup_result.steps));
    assert.deepEqual(stepStatuses(second.cleanup_result)[9], 'succeeded');
    assert.equal(second.leak_audit_result.leak_audit_status, 'clean');
    assert.deepEqual(mutations(account).slice(firstMutations), [], 'a second run deletes and stops nothing again');
  });

  it('reports the stack deletion failed when a durable execution cannot be stopped (RK-10)', async () => {
    const world = cleanupWorld();
    seedTreatment(world, 'RESPONSE_RELEASED');
    const account = new ScriptedRunAccount();
    account.endpoint.answer('lambda:StopDurableExecution', refuse('InvalidParameterValueException', 'busy'));
    account.endpoint.answer('lambda:GetDurableExecution', reply({ DurableExecutionArn: 'a', Status: 'RUNNING' }));

    const outcome = await awsOrchestrator(world, account, 1).runNormal(
      cleanupInput(world, ownershipContext(liveRunManifest())),
    );

    assertConsistentOutcome(world, outcome);
    const result = outcome.cleanup_result;
    // BR-RUA-051: a DELETE_FAILED owned resource makes the cleanup `partial`, and the stack the
    // audit still observes is a leak, not an inconclusive or clean audit.
    assert.equal(result.cleanup_status, 'partial', JSON.stringify(result.steps));
    assert.equal(stepStatuses(result)[5], 'failed');
    assert.equal(resourceActions(result)[`${STACK_RESOURCE_TYPE} ${STACK_ID}`], 'DELETE_FAILED/recorded_stack');
    assert.equal(account.stackDeleted(), false);
    assert.equal(
      outcome.leak_audit_result.leak_audit_status,
      'leaks_detected',
      JSON.stringify(outcome.leak_audit_result),
    );
    // Steps 3, 5 and 9 in order: the stop was tried before the one stack deletion attempt.
    assert.deepEqual(mutations(account).slice(0, 3), [
      'UpdateEventSourceMapping',
      'StopDurableExecution',
      'DeleteStack',
    ]);
    assert.equal(account.endpoint.calls('cloudformation:DeleteStack').length, 1);
  });
});
