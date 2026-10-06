// The cleanup orchestrator under failure (BR-RUA-046 "exceeding it is a duration breach rather
// than permission to abandon cleanup", BR-RUA-048, RK-10): a throwing step, a throwing audit, a
// stopped journal, an unreadable history, a failed freeze and a failed durable stop are each
// recorded, and every remaining step still runs to schema-valid results.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STACK_DELETE_MAX_POLLS } from '../../../src/cleanup/owned-resource-deletion.ts';
import type { CleanupResult } from '../../../src/record-contract/records/group-c/cleanup_result.ts';
import { assertConsistentOutcome, resourceActions, stepStatuses } from '../../support/cleanup/cleanup-assertions.ts';
import { NAMES, STACK_ID } from '../../support/cleanup/cleanup-fixtures.ts';
import {
  CLEANUP_JOURNAL_PATH,
  cleanupInput,
  cleanupOrchestrator,
  cleanupWorld,
  journalHistory,
} from '../../support/cleanup/cleanup-harness.ts';
import { ThrowingLeakAuditRunner } from '../../support/cleanup/throwing-leak-audit-runner.ts';

function reasonsOf(result: CleanupResult, step: number): readonly string[] {
  return (result.steps.find((entry) => entry.step === step)?.reasons ?? []).map((reason) => reason.code);
}

describe('CleanupOrchestrator', () => {
  it('records a throwing step as failed and runs every later step', async () => {
    const world = cleanupWorld();
    world.evidence.throwOn('snapshot');
    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));
    assertConsistentOutcome(world, outcome);
    const result = outcome.cleanup_result;
    assert.equal(stepStatuses(result)[4], 'failed');
    assert.deepEqual(reasonsOf(result, 4), ['STEP_FAILED_UNEXPECTEDLY']);
    assert.match(
      result.steps.find((step) => step.step === 4)?.reasons[0]?.detail ?? '',
      /scripted snapshot evidence fault/,
    );
    assert.equal(result.cleanup_status, 'succeeded');
    assert.equal(stepStatuses(result)[11], 'succeeded');
  });

  it('freezes an inconclusive audit when the audit throws', async () => {
    const world = cleanupWorld();
    const auditor = new ThrowingLeakAuditRunner('audit bug');
    const outcome = await cleanupOrchestrator(world, 1, auditor).runNormal(cleanupInput(world));
    assertConsistentOutcome(world, outcome);
    assert.equal(auditor.callCount(), 1);
    const audit = outcome.leak_audit_result;
    assert.deepEqual(
      [audit.leak_audit_status, audit.passes, audit.stable_absence_interval_ms],
      ['inconclusive', [], 0],
    );
    const result = outcome.cleanup_result;
    assert.deepEqual(reasonsOf(result, 10), ['LEAK_AUDIT_QUERY_FAILED', 'LEAK_AUDIT_THREW']);
    assert.match(
      result.steps.find((step) => step.step === 10)?.reasons[0]?.detail ?? '',
      /no audit pass; expected every surface to answer/,
    );
    assert.deepEqual(reasonsOf(result, 11), ['STABLE_ABSENCE_NOT_PROVEN']);
    assert.match(
      result.steps.find((step) => step.step === 11)?.reasons[0]?.detail ?? '',
      /status inconclusive after 0 ms/,
    );
  });

  it('fails the audit step on a failed surface query', async () => {
    const world = cleanupWorld();
    world.surfaces.failQuery('roles', 2);
    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));
    assertConsistentOutcome(world, outcome);
    assert.equal(outcome.leak_audit_result.leak_audit_status, 'inconclusive');
    assert.match(
      outcome.cleanup_result.steps.find((step) => step.step === 10)?.reasons[0]?.detail ?? '',
      /failed queries on roles; expected every surface to answer/,
    );
  });

  it('goes on after the journal stops, reporting the stop on the step it happened in', async () => {
    const world = cleanupWorld();
    world.file.failWriteAt(CLEANUP_JOURNAL_PATH, 3, 'written_unacknowledged');
    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));
    const result = outcome.cleanup_result;
    assert.equal(result.cleanup_status, 'succeeded');
    assert.deepEqual(reasonsOf(result, 2), ['CLEANUP_JOURNAL_STOPPED']);
    assert.equal(stepStatuses(result)[12], 'started');
    assert.equal(journalHistory(world).entries.length, 3, 'nothing is appended after the stop');
    assert.deepEqual(world.evidence.frozen().at(-1)?.cleanup_result, result);
  });

  it('attaches unreadable history lines to the first step it runs, and re-runs their steps', async () => {
    const world = cleanupWorld();
    world.file.seedRaw(CLEANUP_JOURNAL_PATH, new TextEncoder().encode('{"torn":\n'));
    const outcome = await cleanupOrchestrator(world, 2).runEmergency(cleanupInput(world));
    const result = outcome.cleanup_result;
    assert.deepEqual(reasonsOf(result, 3), ['CLEANUP_HISTORY_LINE_SKIPPED']);
    assert.deepEqual(reasonsOf(result, 1), []);
    assert.equal(result.cleanup_status, 'succeeded');
  });

  it('reports a failed or throwing freeze in its outcome and journal', async () => {
    const world = cleanupWorld();
    world.evidence.answer('freeze', {
      status: 'failed',
      reasons: [{ code: 'PACKAGE_FINALIZED', subject: 'index', detail: 'd' }],
    });
    const failed = await cleanupOrchestrator(world).runNormal(cleanupInput(world));
    assert.equal(failed.freeze.status, 'failed');
    assert.deepEqual(journalHistory(world).entries.at(-1)?.body.step_status, 'failed');

    const throwing = cleanupWorld();
    throwing.evidence.throwOn('freeze');
    const thrown = await cleanupOrchestrator(throwing).runNormal(cleanupInput(throwing));
    assert.deepEqual(
      thrown.freeze.reasons.map((reason) => reason.code),
      ['STEP_FAILED_UNEXPECTEDLY'],
    );
  });

  it('records a skipped evidence step as skipped (emergency cutoff)', async () => {
    const world = cleanupWorld();
    world.evidence.answer('cutoff', {
      status: 'skipped',
      reasons: [{ code: 'EMERGENCY_CUTOFF_SKIPPED', subject: 'late-evidence', detail: 'd' }],
    });
    const outcome = await cleanupOrchestrator(world).runEmergency(cleanupInput(world));
    assertConsistentOutcome(world, outcome);
    assert.equal(stepStatuses(outcome.cleanup_result)[1], 'skipped');
  });

  it('leaves the stack deletion blocked when a durable stop fails (RK-10)', async () => {
    const world = cleanupWorld();
    world.executions.start(NAMES.durableFunction, 'arn:durable/stuck');
    world.executions.failStop('arn:durable/stuck');
    const outcome = await cleanupOrchestrator(world).runNormal(cleanupInput(world));
    assertConsistentOutcome(world, outcome);
    const result = outcome.cleanup_result;
    assert.equal(world.stack.blockedReads(), STACK_DELETE_MAX_POLLS);
    assert.equal(stepStatuses(result)[5], 'failed');
    assert.equal(result.cleanup_status, 'partial');
    assert.equal(resourceActions(result)[`AWS::CloudFormation::Stack ${STACK_ID}`], 'DELETE_FAILED/recorded_stack');
    assert.deepEqual(result.stopped_durable_execution_arns, []);
    assert.equal(outcome.leak_audit_result.leak_audit_status, 'leaks_detected');
  });
});
