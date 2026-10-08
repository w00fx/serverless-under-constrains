// `probe|validation|run execute` over the real `ExecutionRunner` and the offline cloud (design §11,
// §10.2 P1-P9; AC-RUA-002, AC-RUA-021, AC-RUA-027): a clean execution exits 0 with the finalized
// package, and a repeated command is refused; a refused lease exits 7; a leaked execution exits 6;
// an operator SIGINT exits 4 after cleanup ran to its end. The composition's deployment latch and
// unit-start decorators are bound the way `createAwsExecutionSessions` binds them. This is also
// the conformance test of `ScriptedExecutionSession`: the real runner gives the same answers the
// unit tests script.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS, executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import {
  DeploymentLatch,
  LatchingProvisioner,
  PROBE_UNIT_START_KEY,
  StartRecordingProbeRunner,
  StartRecordingTrialRunner,
  UnitStartRegistry,
} from '../../../src/operator-cli/deployment-latch.ts';
import type { ExecutionIdentity } from '../../../src/record-contract/primitives.ts';
import { ScriptedExecutionLease } from '../execution-lifecycle/fakes/scripted-execution-lease.ts';
import { ScriptedProbeRunner } from '../execution-lifecycle/fakes/scripted-probe-runner.ts';
import { ProbeRunnerWorld } from '../execution-lifecycle/support/probe-runner-world.ts';
import { RunnerWorld } from '../execution-lifecycle/support/runner-world.ts';
import { driveUntilSettled } from '../execution-lifecycle/support/virtual-drive.ts';
import { runCli } from '../../unit/operator-cli/support/cli-harness.ts';
import type { CliRun } from '../../unit/operator-cli/support/cli-harness.ts';
import { STORED_EVIDENCE_ROOT, packageOperand } from '../../unit/operator-cli/support/stored-packages.ts';
import { executeCommandOver, leasedExecution, retainProviderVersion } from './support/offline-executions.ts';
import type { WorldCommand } from './support/offline-executions.ts';

const ROOT_FLAG = ['--evidence-root', STORED_EVIDENCE_ROOT];

function executeArgs(word: string, identity: ExecutionIdentity): readonly string[] {
  return [word, 'execute', packageOperand(identity), '--confirm-cloud-mutation', executionIdOf(identity), ...ROOT_FLAG];
}

function runExecute(world: RunnerWorld, bound: WorldCommand = executeCommandOver(world, 'RUN')): Promise<CliRun> {
  return world.drive(runCli(executeArgs('run', world.admitted.identity), [bound.command]));
}

describe('run execute over the offline runner', () => {
  it('exits 0 with the finalized package, latching P2 and every trial start, and refuses a second execute', async () => {
    const latch = new DeploymentLatch();
    let starts: UnitStartRegistry | undefined;
    const world = await RunnerWorld.create({
      deps: (built) => {
        starts = new UnitStartRegistry(built.cloud.time);
        return {
          provisioner: new LatchingProvisioner(built.provisioner, latch),
          trials: new StartRecordingTrialRunner(built.cloud.executor, starts),
        };
      },
    });
    const run = await runExecute(world);
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.outcome, 'completed');
    assert.equal(run.result.run_id, executionIdOf(world.admitted.identity));
    assert.deepEqual(run.result.written_paths, [`${world.admitted.package_directory}/${EXECUTION_PATHS.packageIndex}`]);
    assert.ok(world.file(EXECUTION_PATHS.packageIndex) !== undefined);
    assert.deepEqual(
      latch.deployed()?.resource_manifest,
      JSON.parse(new TextDecoder().decode(world.resourceManifestBytes)),
    );
    assert.ok(latch.deployed()?.targets !== undefined);
    assert.deepEqual(
      [...(starts?.view().keys() ?? [])],
      world.admitted.manifest.trials.map((trial) => trial.trial_id),
    );
    const again = await runExecute(world);
    assert.equal(again.exit_code, 5);
    assert.deepEqual(
      again.result.reasons.map((reason) => reason.code),
      ['PACKAGE_ALREADY_EXECUTED'],
    );
  });

  it('exits 7 when the coordination lease is refused, with the package finalized and nothing deployed', async () => {
    const refusal = { code: 'LEASE_HELD', subject: 'BR-RUA-045', detail: 'a foreign owner holds the lease' };
    const world = await RunnerWorld.create({ deps: () => ({ lease: new ScriptedExecutionLease({ refusal }) }) });
    const run = await runExecute(world);
    assert.equal(run.exit_code, 7, JSON.stringify(run.result.reasons));
    assert.equal(world.provisioner.provisions(), 0);
    assert.deepEqual(run.result.reasons.map((reason) => reason.code).at(-1), 'LEASE_NOT_ACQUIRED');
    // The runner journals the refusal and its outcome names it (CMP-05 review, WP-28 residual).
    assert.equal(run.result.reasons[0]?.code, 'LEASE_HELD');
    assert.ok(world.runnerEvents().includes('LEASE_ACQUISITION:failed'));
    assert.match(JSON.stringify(world.journal(EXECUTION_PATHS.runnerJournal)), /"code":"LEASE_HELD"/);
  });

  it('exits 6 when cleanup leaks and the real lease is left for recovery', async () => {
    const { world } = await leasedExecution();
    retainProviderVersion(world);
    const run = await runExecute(world);
    assert.equal(run.exit_code, 6, JSON.stringify(run.result.reasons));
    assert.equal(run.result.reasons.at(-1)?.code, 'OPERATIONAL_CLOSURE_NOT_CLEAN');
    assert.match(
      run.result.reasons.at(-1)?.detail ?? '',
      /^cleanup partial, leak audit leaks_detected, lease recovery_required; /,
    );
  });

  it('exits 4 after an operator SIGINT, aborting once and still cleaning up', async () => {
    const world = await RunnerWorld.create();
    const bound = executeCommandOver(world, 'RUN');
    let fired = 0;
    const work = runCli(executeArgs('run', world.admitted.identity), [bound.command]);
    const run = await driveUntilSettled(async () => {
      if (fired < 2 && bound.interrupts.listening() > 0 && world.runnerEvents().length > 3) {
        bound.interrupts.fire();
        fired += 1;
      }
      await world.cloud.advanceBy(1000);
    }, work);
    assert.equal(fired, 2);
    assert.equal(run.exit_code, 4, JSON.stringify(run.result.reasons));
    assert.equal(run.result.reasons.at(-1)?.code, 'EXECUTION_INCOMPLETE');
    assert.match(run.result.reasons.at(-1)?.detail ?? '', /interruption OPERATOR_ABORT \(SIGINT\)/);
    assert.deepEqual(run.stderr_lines.slice(1), [
      'SIGINT: interrupting the execution (OPERATOR_ABORT); cleanup still runs to its end',
      'SIGINT again: the execution is already interrupted; cleanup still runs to its end',
    ]);
    assert.equal(bound.interrupts.listening(), 0);
    const cleanup = world.record(EXECUTION_PATHS.cleanupResult);
    assert.equal(cleanup['cleanup_status'], 'succeeded');
  });
});

describe('probe execute over the offline probe runner', () => {
  it('exits 0 for the golden probe', async () => {
    const world = await ProbeRunnerWorld.create();
    const { command } = executeCommandOver(world, 'TRANSPORT_PROBE');
    const run = await world.drive(runCli(executeArgs('probe', world.admitted.identity), [command]));
    assert.equal(run.exit_code, 0, JSON.stringify(run.result.reasons));
    assert.equal(run.result.transport_probe_id, executionIdOf(world.admitted.identity));
    assert.deepEqual(run.result.written_paths, [`${world.admitted.package_directory}/${EXECUTION_PATHS.packageIndex}`]);
  });

  it('records the probe start under its telemetry key and exits 4 when the probe never started', async () => {
    let starts: UnitStartRegistry | undefined;
    const world = await ProbeRunnerWorld.create({
      deps: (built) => {
        starts = new UnitStartRegistry(built.cloud.time);
        return { probe: new StartRecordingProbeRunner(new ScriptedProbeRunner(), starts) };
      },
    });
    const { command } = executeCommandOver(world, 'TRANSPORT_PROBE');
    const run = await world.drive(runCli(executeArgs('probe', world.admitted.identity), [command]));
    assert.equal(run.exit_code, 4, JSON.stringify(run.result.reasons));
    assert.deepEqual([...(starts?.view().keys() ?? [])], [PROBE_UNIT_START_KEY]);
  });
});
