// AC-RUA-049 The Safety Deadline Is Reached (BR-RUA-046), on the virtual clock: when the
// active-time deadline is reached no new trial starts, the active trial (if any) freezes
// indeterminate with what it observed, monitoring is skipped, emergency cleanup runs every step and
// goes on past the total target, and the cleanup result and safety assessment record the breach.
//
// The real `SafetySupervisor` measures the deadline. Its limits are compressed (the run maximums
// would take 75 virtual minutes): a calibration run with the run maximums journals when each trial
// starts and freezes, and the deadline is placed inside the interval each case needs. The total
// target is set 1 ms past the deadline, so cleanup, whose stable-absence audit alone takes 120 s,
// necessarily runs past it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ExecutionRunnerDeps } from '../../../src/execution-lifecycle/execution-runner.ts';
import type { ExecutionOutcome } from '../../../src/execution-lifecycle/execution-ports.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { SafetyLimits } from '../../../src/safety/safety-limits.ts';
import { RUN_SAFETY } from '../../../src/safety/safety-limits.ts';
import { latentTrialExecutor } from './support/latent-trials.ts';
import { RunnerWorld } from './support/runner-world.ts';

/** How long each evidence file of a trial takes to create in the between-trials case. */
const WRITE_LATENCY_MS = 2_000;

function compressed(activeMs: number): SafetyLimits {
  return { ...RUN_SAFETY, active_ms: activeMs, total_ms: activeMs + 1 };
}

function eventOf(type: string, trialId?: string): (event: JsonObject) => boolean {
  return (event) => event['record_type'] === type && (trialId === undefined || event['trial_id'] === trialId);
}

function latentDeps(world: RunnerWorld): Partial<ExecutionRunnerDeps> {
  return { trials: latentTrialExecutor(world.cloud, WRITE_LATENCY_MS) };
}

// What every interrupted execution must show, whichever moment the deadline fell on.
function assertControlledInterruption(world: RunnerWorld, outcome: ExecutionOutcome, startedTrials: number): void {
  const declared = world.admitted.manifest.trials.map((trial) => trial.trial_id);
  assert.equal(outcome.interruption?.cause, 'SAFETY_DEADLINE');
  assert.equal(outcome.trials.length, startedTrials, 'no trial starts after the deadline');
  for (const trialId of declared.slice(startedTrials)) {
    assert.equal(world.file(`trials/${trialId}/trial-manifest.json`), undefined, `${trialId} never started`);
  }
  const published = world.journal(EXECUTION_PATHS.runnerJournal).filter(eventOf('trial_message_published'));
  assert.equal(published.length, startedTrials);
  for (const report of outcome.trials) {
    assert.equal(report.kind, 'frozen', 'available evidence is preserved');
    assert.ok(world.file(`trials/${report.trial_id}/evidence-index.json`) !== undefined);
  }

  const phases = world.runnerEvents();
  assert.ok(phases.includes('TRIALS:failed'));
  assert.ok(phases.includes('LATE_MONITORING:skipped'), 'monitoring is skipped after an interruption');
  assert.ok(phases.indexOf('LATE_MONITORING:skipped') < phases.indexOf('CLEANUP:started'));

  const cleanup = world.record(EXECUTION_PATHS.cleanupResult);
  assert.equal(cleanup['cleanup_mode'], 'EMERGENCY');
  assert.equal(cleanup['duration_breach'], true, 'cleanup went on past the total target');
  assert.equal(cleanup['cleanup_status'], 'succeeded');
  const steps = (cleanup['steps'] as readonly JsonObject[]).map((step) => step['step']);
  assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'cleanup ran every step');
  assert.equal(outcome.cleanup_status, 'succeeded');
  assert.equal(outcome.leak_audit_status, 'clean');

  const late = world.record(EXECUTION_PATHS.lateEvidenceAssessment);
  assert.equal(late['monitoring'], 'skipped');
  assert.equal(late['late_evidence_status'], 'unverified', 'emergency cleanup leaves late evidence unverified');

  const safety = world.record(EXECUTION_PATHS.safetyAssessment);
  assert.equal(safety['safety_status'], 'breached');
  const breached = (safety['reasons'] as readonly JsonObject[]).map((reason) => reason['code']);
  assert.ok(breached.includes('TOTAL_TIME_BREACHED'));

  const summary = world.record(EXECUTION_PATHS.runSummary);
  assert.equal(summary['run_terminal_reason'], 'SAFETY_DEADLINE');
  assert.equal(summary['execution_status'], 'incomplete');
  assert.equal(outcome.package_finalized, true);
  assert.ok(world.file(EXECUTION_PATHS.packageIndex) !== undefined);
}

describe('AC-RUA-049 the safety deadline is reached', () => {
  it('deadline-during-trial', async () => {
    const calibration = await RunnerWorld.create();
    await calibration.run();
    const second = calibration.admitted.manifest.trials[1]?.trial_id ?? '';
    const started = calibration.elapsedMsAt(eventOf('trial_message_published', second));
    const assessed = calibration.elapsedMsAt(eventOf('settlement_assessed', second));
    assert.ok(assessed - started > 60_000, 'the second trial observes for more than a minute');

    const world = await RunnerWorld.create({ limits: compressed(started + 30_000) });
    const outcome = await world.run();

    assertControlledInterruption(world, outcome, 2);
    const [first, interrupted] = outcome.trials;
    assert.ok(first?.kind === 'frozen' && first.interruption === undefined, 'the trial before the deadline is whole');
    assert.ok(interrupted?.kind === 'frozen');
    assert.equal(interrupted.trial_id, second);
    assert.deepEqual(interrupted.interruption?.cause, 'SAFETY_DEADLINE');
    assert.equal(interrupted.settlement.status, 'not_established', 'the interrupted trial is indeterminate');
    const marked = world.journal(EXECUTION_PATHS.runnerJournal).filter(eventOf('trial_interrupted'));
    assert.deepEqual(
      marked.map((event) => [event['trial_id'], event['cause']]),
      [[second, 'SAFETY_DEADLINE']],
      'the trial journals its own interruption; the runner does not journal it again',
    );
    // The oracle judges what was preserved: an interrupted trial is indeterminate, never a pass.
    const oracle = world.record(`trials/${second}/derived/oracle-result.json`);
    assert.equal(oracle['preservation_verdict'], 'indeterminate');
    assert.equal(oracle['trial_validity'], 'indeterminate');
    assert.equal(oracle['correct_completion'], null);
    assert.equal(oracle['processing_terminal_reason'], 'SAFETY_DEADLINE');
  });

  // Beyond the two AC-RUA-049 cases: monitoring is active work, so the deadline shortens it and the
  // ACTIVE_TIME check counts it.
  it('deadline-during-late-monitoring', async () => {
    const calibration = await RunnerWorld.create();
    await calibration.run();
    const monitoring = calibration.elapsedMsAt(
      (event) => event['phase'] === 'LATE_MONITORING' && event['status'] === 'started',
    );
    const deadline = monitoring + 60_000;

    const world = await RunnerWorld.create({ limits: compressed(deadline) });
    const outcome = await world.run();

    assert.equal(outcome.interruption?.cause, 'SAFETY_DEADLINE');
    assert.deepEqual(
      outcome.trials.map((report) => report.kind === 'frozen' && report.interruption === undefined),
      [true, true, true, true],
      'every trial froze whole before the deadline',
    );
    const phases = world.runnerEvents();
    assert.ok(phases.includes('LATE_MONITORING:failed'));
    assert.equal(world.record(EXECUTION_PATHS.lateEvidenceAssessment)['monitoring'], 'shortened');
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
    assert.equal(world.record(EXECUTION_PATHS.runSummary)['run_terminal_reason'], 'SAFETY_DEADLINE');
    const checks = world.record(EXECUTION_PATHS.safetyAssessment)['checks'] as readonly JsonObject[];
    const active = checks.find((check) => check['boundary'] === 'ACTIVE_TIME');
    assert.ok(
      Number.parseInt(String(active?.['observed']), 10) >= deadline,
      `active time runs until the deadline cut monitoring short; observed ${String(active?.['observed'])}`,
    );
  });

  it('deadline-between-trials', async () => {
    const calibration = await RunnerWorld.create({ deps: latentDeps });
    await calibration.run();
    const first = calibration.admitted.manifest.trials[0]?.trial_id ?? '';
    const assessed = calibration.elapsedMsAt(eventOf('settlement_assessed', first));
    const frozen = calibration.elapsedMsAt(eventOf('trial_evidence_frozen', first));
    assert.ok(frozen - assessed >= 2 * WRITE_LATENCY_MS, 'the first trial takes time to freeze');

    const world = await RunnerWorld.create({
      deps: latentDeps,
      limits: compressed(Math.floor((assessed + frozen) / 2)),
    });
    const outcome = await world.run();

    assertControlledInterruption(world, outcome, 1);
    const [whole] = outcome.trials;
    assert.ok(whole?.kind === 'frozen');
    assert.equal(whole.interruption, undefined, 'the deadline came after the trial stopped observing');
    assert.equal(whole.settlement.status, 'established');
    const marked = world.journal(EXECUTION_PATHS.runnerJournal).filter(eventOf('trial_interrupted'));
    assert.deepEqual(
      marked.map((event) => [event['trial_id'], event['cause']]),
      [[undefined, 'SAFETY_DEADLINE']],
      'the runner journals the interruption no trial recorded',
    );
    const second = world.admitted.manifest.trials[1]?.trial_id ?? '';
    assert.equal(world.file(`trials/${second}/trial-manifest.json`), undefined);
  });
});
