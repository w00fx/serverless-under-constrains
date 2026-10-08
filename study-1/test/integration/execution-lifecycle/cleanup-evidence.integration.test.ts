// The evidence cleanup reads and freezes inside the package (design §10.4 steps 4, 7 and 12;
// BR-RUA-048): step 7 deletes exactly the DLQ messages the trials' frozen snapshots captured, an
// unreadable snapshot fails the step instead of widening or narrowing what is deleted, and results
// that cannot be frozen fail the cleanup phase and keep the lease from being released.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS, UNIT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import { dlqSnapshot } from '../../contract/record-contract/group-b/examples/observation-examples.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { ScriptedTrialRunner } from './fakes/scripted-trial-runner.ts';
import { RunnerWorld } from './support/runner-world.ts';

function stepOf(world: RunnerWorld, step: number): JsonObject | undefined {
  const steps = world.record(EXECUTION_PATHS.cleanupResult)['steps'] as readonly JsonObject[];
  return steps.find((entry) => entry['step'] === step);
}

describe('ExecutionCleanupEvidence', () => {
  it('deletes the DLQ messages the frozen snapshots captured, and fails the capture for an unreadable one', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    const [first, second] = world.admitted.manifest.trials;
    const directory = world.admitted.package_directory;
    world.account.dlq.add('message-0002');
    await world.cloud.storage.writeOnce(
      `${directory}/trials/${first?.trial_id ?? ''}/${UNIT_PATHS.dlqSnapshot}`,
      serializeRecordFile(dlqSnapshot() satisfies StudyRecord),
    );
    await world.cloud.storage.writeOnce(
      `${directory}/trials/${second?.trial_id ?? ''}/${UNIT_PATHS.dlqSnapshot}`,
      new TextEncoder().encode('{"record_type":"dlq_snapshot"}\n'),
    );
    const third = world.admitted.manifest.trials[2];
    await world.cloud.storage.writeOnce(
      `${directory}/trials/${third?.trial_id ?? ''}/${UNIT_PATHS.dlqSnapshot}`,
      new TextEncoder().encode('not json\n'),
    );
    const outcome = await world.run();
    assert.deepEqual(world.account.dlq.requested(), ['message-0002']);
    assert.deepEqual(world.account.dlq.remaining(), []);
    const capture = stepOf(world, 7);
    assert.equal(capture?.['status'], 'failed');
    const reasons = capture['reasons'] as readonly JsonObject[];
    assert.deepEqual(
      reasons.map((reason) => (reason['detail'] as string).split('/')[1]).toSorted(),
      [second?.trial_id, third?.trial_id].toSorted(),
    );
    assert.ok(reasons.every((reason) => reason['code'] === 'DLQ_SNAPSHOT_UNREADABLE'));
    // `cleanup_status` judges the deletion phase (step 9) alone; the failed capture stays on step 7.
    assert.equal(outcome.cleanup_status, 'succeeded');
  });

  // A-05: snapshots are read back from disk; hostile ones fail the capture, never the cleanup.
  it('refuses DLQ snapshots nested 100,000 levels deep, past the double range or with inherited names', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    const directory = world.admitted.package_directory;
    const valid = new TextDecoder().decode(serializeRecordFile(dlqSnapshot() satisfies StudyRecord));
    const hostile = [
      towerText('mixed', DEEP_NESTING, '1'),
      valid.replace('"schema_version":1', `"schema_version":${towerText('array', DEEP_NESTING, '1')}`),
      valid.replace('"schema_version":1', '"schema_version":1e400'),
      valid.replace('{', '{"__proto__":{"messages":[]},'),
    ];
    const trials = world.admitted.manifest.trials;
    for (const [index, text] of hostile.entries()) {
      await world.cloud.storage.writeOnce(
        `${directory}/trials/${trials[index]?.trial_id ?? ''}/${UNIT_PATHS.dlqSnapshot}`,
        new TextEncoder().encode(`${text}\n`),
      );
    }
    const outcome = await world.run();
    const capture = stepOf(world, 7);
    assert.equal(capture?.['status'], 'failed');
    const reasons = capture['reasons'] as readonly JsonObject[];
    assert.deepEqual(
      reasons.map((reason) => reason['code']),
      hostile.map(() => 'DLQ_SNAPSHOT_UNREADABLE'),
    );
    assert.ok(reasons.every((reason) => (reason['detail'] as string).length < 1_000));
    assert.equal(outcome.package_finalized, true);
  });

  it('fails the snapshot step when the pre-cleanup snapshot cannot be written', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    world.cloud.storage.seedRaw(
      `${world.admitted.package_directory}/${EXECUTION_PATHS.preCleanupSnapshot}`,
      new Uint8Array([1]),
    );
    await world.run();
    const snapshot = stepOf(world, 4);
    assert.equal(snapshot?.['status'], 'failed');
    assert.deepEqual(
      (snapshot['reasons'] as readonly JsonObject[]).map((reason) => reason['code']),
      ['PACKAGE_FILE_NOT_WRITTEN'],
    );
  });

  it('fails the cleanup phase when its results cannot be frozen', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    world.cloud.storage.seedRaw(
      `${world.admitted.package_directory}/${EXECUTION_PATHS.leakAuditResult}`,
      new Uint8Array([1]),
    );
    const outcome = await world.run();
    assert.ok(world.runnerEvents().includes('CLEANUP:failed'));
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_status'], 'succeeded');
    assert.equal(outcome.lease_status, 'recovery_required', 'a closure whose results are not frozen is not clean');
  });
});
