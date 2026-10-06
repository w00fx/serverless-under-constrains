// How the execution runner closes (design §10.2 P4, P6, P7, P9, §11; BR-RUA-033, BR-RUA-043,
// BR-RUA-044, BR-RUA-045, BR-RUA-046): a lost lease between trials and a SIGINT during monitoring
// interrupt and send cleanup to emergency mode, a SIGINT during cleanup never abandons it, a runner
// journal that stops is reported while the execution carries on, and every evidence write that fails
// is a reason, with `package-index.json` written last only when the whole package is finalized.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { MemoryAppendOnlyFile } from '../../support/event-journal/memory-append-only-file.ts';
import { FinalizeRefusingPackageStorage } from './fakes/finalize-refusing-package-storage.ts';
import { ScriptedTrialRunner } from './fakes/scripted-trial-runner.ts';
import { RunnerWorld } from './support/runner-world.ts';

// About 5 s of readiness, then trials that take no time: 60 s in falls inside the 120 s window.
const DURING_MONITORING_MS = 60_000;

function phaseReasons(world: RunnerWorld, phase: string): readonly unknown[] {
  return world
    .journal(EXECUTION_PATHS.runnerJournal)
    .filter((event) => event['phase'] === phase && event['status'] !== 'started')
    .flatMap((event) => (event['reasons'] as readonly JsonObject[]).map((reason) => reason['code']));
}

describe('ExecutionRunner variant validation', () => {
  it('runs a variant validation to a finalized package whose late evidence names the validation', async () => {
    const world = await RunnerWorld.create({ name: 'validation-conventional' });
    const outcome = await world.run();
    assert.equal(outcome.package_finalized, true);
    const identity = world.admitted.identity;
    assert.equal(identity.execution_kind, 'VARIANT_VALIDATION');
    const assessment = world.record(EXECUTION_PATHS.lateEvidenceAssessment);
    assert.equal(assessment['variant_validation_id'], identity.variant_validation_id);
    assert.equal(assessment['run_id'], undefined);
  });
});

describe('ExecutionRunner interruptions', () => {
  it('stops starting trials once the lease is lost, and journals the interruption no trial recorded', async () => {
    const trials = new ScriptedTrialRunner('not_started', (sequence) => {
      if (sequence === 2) {
        world.lease.lose();
      }
    });
    const world: RunnerWorld = await RunnerWorld.create({ deps: () => ({ trials }) });
    const outcome = await world.run();
    assert.deepEqual(
      trials.plans().map((plan) => plan.trial.sequence),
      [1, 2],
    );
    assert.equal(outcome.interruption?.cause, 'LEASE_LOST');
    const marked = world
      .journal(EXECUTION_PATHS.runnerJournal)
      .filter((event) => event['record_type'] === 'trial_interrupted');
    assert.deepEqual(
      marked.map((event) => event['cause']),
      ['LEASE_LOST'],
    );
    assert.deepEqual(phaseReasons(world, 'TRIALS'), ['EXECUTION_INTERRUPTED']);
    assert.deepEqual(phaseReasons(world, 'LATE_MONITORING'), ['EXECUTION_INTERRUPTED']);
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
  });

  it('shortens monitoring on SIGINT, leaves late evidence unverified and cleans up in emergency mode', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    world.cloud.time.schedule(DURING_MONITORING_MS, () => world.runner.abort('SIGINT'));
    const outcome = await world.run();
    assert.equal(outcome.interruption?.cause, 'OPERATOR_ABORT');
    assert.ok(world.runnerEvents().includes('LATE_MONITORING:failed'));
    assert.deepEqual(phaseReasons(world, 'LATE_MONITORING'), ['EXECUTION_INTERRUPTED']);
    const late = world.record(EXECUTION_PATHS.lateEvidenceAssessment);
    assert.equal(late['monitoring'], 'shortened');
    assert.equal(late['late_evidence_status'], 'unverified');
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
  });

  it('keeps cleaning up after a SIGINT during cleanup, and reports the interruption', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    // Readiness (5 s) and monitoring (120 s) are over by 130 s; cleanup's audit then waits 120 s.
    world.cloud.time.schedule(130_000 + DURING_MONITORING_MS, () => world.runner.abort('SIGINT'));
    const outcome = await world.run();
    assert.ok(world.runnerEvents().includes('LATE_MONITORING:succeeded'));
    const cleanup = world.record(EXECUTION_PATHS.cleanupResult);
    assert.equal(cleanup['cleanup_mode'], 'NORMAL');
    assert.equal(cleanup['cleanup_status'], 'succeeded');
    assert.equal(outcome.interruption?.cause, 'OPERATOR_ABORT');
    assert.equal(outcome.lease_status, 'released');
    assert.equal(outcome.package_finalized, true);
  });
});

describe('ExecutionRunner evidence that cannot be written', () => {
  it('carries on when the runner journal stops, logging every event it could not write', async () => {
    const journals = new MemoryAppendOnlyFile();
    const world = await RunnerWorld.create({
      deps: (built) => {
        // Line 5 is READINESS started: written, but never acknowledged, so the writer stops.
        journals.failWriteAt(
          `${built.admitted.package_directory}/${EXECUTION_PATHS.runnerJournal}`,
          5,
          'written_unacknowledged',
        );
        return { trials: new ScriptedTrialRunner(), evidence: { files: built.cloud.storage, journals } };
      },
    });
    const outcome = await world.run();
    const notWritten = world.logs.filter((line) => line.event === 'runner_event_not_written');
    assert.ok(notWritten.length >= 5);
    assert.match(notWritten[0]?.detail ?? '', /phase_transition_recorded was not appended/);
    assert.equal(outcome.cleanup_status, 'succeeded', 'readiness, trials and cleanup still ran');
    assert.equal(outcome.package_finalized, true);
  });

  it('reports a safety assessment and execution evidence it could not write', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    const directory = world.admitted.package_directory;
    world.cloud.storage.seedRaw(`${directory}/${EXECUTION_PATHS.safetyAssessment}`, new Uint8Array([0x7b]));
    world.cloud.storage.seedRaw(`${directory}/${EXECUTION_PATHS.canaryCallerJournal}`, new Uint8Array());
    const outcome = await world.run();
    const codes = outcome.reasons.map((reason) => `${reason.code} ${String(reason.artifact_path)}`);
    assert.ok(codes.includes(`PACKAGE_FILE_NOT_WRITTEN ${EXECUTION_PATHS.safetyAssessment}`));
    assert.ok(codes.includes(`PACKAGE_FILE_NOT_WRITTEN ${EXECUTION_PATHS.canaryCallerJournal}`));
    assert.ok(world.runnerEvents().includes('SUMMARY:failed'));
    assert.ok(world.logs.some((line) => line.event === 'execution_reason'));
  });

  it('writes no package index when a journal cannot be made read-only', async () => {
    const storage = new FinalizeRefusingPackageStorage();
    const world = await RunnerWorld.create({
      deps: () => ({ trials: new ScriptedTrialRunner(), evidence: { files: storage, journals: storage } }),
    });
    for (const [path, bytes] of world.cloud.packageFiles()) {
      await storage.writeOnce(`${world.admitted.package_directory}/${path}`, bytes);
    }
    const outcome = await world.run();
    assert.equal(outcome.package_finalized, false);
    assert.ok(outcome.reasons.some((reason) => reason.code === 'PACKAGE_NOT_FINALIZED'));
    assert.equal(storage.filesUnder(world.admitted.package_directory).get(EXECUTION_PATHS.packageIndex), undefined);
    assert.ok(storage.refused().length >= 2);
  });

  it('writes no package index when the package cannot be listed', async () => {
    const world = await RunnerWorld.create({ deps: () => ({ trials: new ScriptedTrialRunner() }) });
    world.cloud.storage.failNextLists(1_000);
    const outcome = await world.run();
    assert.equal(outcome.package_finalized, false);
    assert.ok(outcome.reasons.some((reason) => reason.code === 'PACKAGE_UNREADABLE'));
    assert.equal(world.file(EXECUTION_PATHS.packageIndex), undefined);
  });
});
