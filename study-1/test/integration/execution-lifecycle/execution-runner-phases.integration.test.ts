// The execution runner's phases when one of them fails (design §10.2 P1-P3, P8; BR-RUA-045,
// BR-RUA-046, BR-RUA-047): a refused lease or an abort before it stops without any mutation, a
// failed deploy goes straight to emergency cleanup, a stack that never becomes ready runs no trial,
// trials that cannot be planned run none, and every outcome still ends in a finalized package.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { OfflineProvisioner } from './fakes/offline-provisioner.ts';
import { ScriptedExecutionLease } from './fakes/scripted-execution-lease.ts';
import { ScriptedTrialRunner } from './fakes/scripted-trial-runner.ts';
import { targetsOf } from './support/execution-fixtures.ts';
import { RunnerWorld } from './support/runner-world.ts';

const REFUSAL = { code: 'LEASE_HELD', subject: 'BR-RUA-045', detail: 'a foreign owner holds the lease' };

function reasonCodes(world: RunnerWorld, phase: string, status: string): readonly unknown[] {
  return world
    .journal(EXECUTION_PATHS.runnerJournal)
    .filter((event) => event['phase'] === phase && event['status'] === status)
    .flatMap((event) => (event['reasons'] as readonly JsonObject[]).map((reason) => reason['code']));
}

describe('ExecutionRunner P1: the lease', () => {
  it('stops without provisioning when the lease is refused, and still finalizes the package', async () => {
    const lease = new ScriptedExecutionLease({ refusal: REFUSAL });
    const world = await RunnerWorld.create({ deps: () => ({ lease }) });
    const outcome = await world.run();
    assert.deepEqual(world.runnerEvents(), [
      'LEASE_ACQUISITION:started',
      'LEASE_ACQUISITION:failed',
      'SUMMARY:started',
      'SUMMARY:failed',
    ]);
    assert.deepEqual(reasonCodes(world, 'LEASE_ACQUISITION', 'failed'), ['LEASE_HELD']);
    assert.equal(world.provisioner.provisions(), 0);
    assert.ok(world.account.log.isEmpty(), 'nothing was mutated');
    assert.deepEqual(lease.calls(), ['acquire']);
    assert.equal(world.file(EXECUTION_PATHS.safetyAssessment), undefined, 'no deadline clock ever ran');
    assert.equal(outcome.package_finalized, true);
    assert.equal(outcome.lease_status, undefined);
    assert.equal(outcome.cleanup_status, undefined);
    assert.equal(outcome.interruption, undefined);
  });

  it('records an abort before the lease and skips acquisition', async () => {
    const world = await RunnerWorld.create();
    assert.equal(world.runner.abort('SIGINT'), 'interrupting');
    assert.equal(world.runner.abort('SIGINT'), 'already_interrupted');
    const outcome = await world.run();
    assert.deepEqual(world.runnerEvents().slice(0, 3), [
      'LEASE_ACQUISITION:started',
      'trial_interrupted',
      'LEASE_ACQUISITION:skipped',
    ]);
    assert.deepEqual(reasonCodes(world, 'LEASE_ACQUISITION', 'skipped'), ['EXECUTION_INTERRUPTED']);
    assert.deepEqual(world.lease.calls(), []);
    assert.deepEqual(outcome.interruption, { cause: 'OPERATOR_ABORT', detail: 'SIGINT' });
    assert.equal(outcome.package_finalized, true);
    assert.ok(world.logs.some((line) => line.event === 'execution_interrupted'));
  });
});

describe('ExecutionRunner P2: provisioning', () => {
  it('sends a failed deploy straight to emergency cleanup and releases the lease after a clean closure', async () => {
    const world = await RunnerWorld.create({ targets: null });
    const outcome = await world.run();
    const events = world.runnerEvents();
    assert.deepEqual(events.slice(0, 4), [
      'LEASE_ACQUISITION:started',
      'LEASE_ACQUISITION:succeeded',
      'PROVISIONING:started',
      'PROVISIONING:failed',
    ]);
    assert.equal(events[4], 'CLEANUP:started', 'no readiness, trial or monitoring after a failed deploy');
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
    assert.equal(outcome.cleanup_status, 'succeeded');
    assert.equal(outcome.lease_status, 'released');
    assert.deepEqual(world.lease.calls(), ['acquire', 'startHeartbeats', 'stopHeartbeats', 'finalize:clean']);
    assert.deepEqual(outcome.trials, []);
  });

  it('notices an abort that arrived during the deploy before readiness', async () => {
    const world = await RunnerWorld.create({
      deps: (built) => ({
        provisioner: new OfflineProvisioner({
          bytes: built.resourceManifestBytes,
          targets: targetsOf(built.cloud.execution),
          log: built.account.log,
          during: (): void => {
            built.runner.abort('SIGINT');
          },
        }),
      }),
    });
    const outcome = await world.run();
    const events = world.runnerEvents();
    assert.ok(events.includes('PROVISIONING:succeeded'));
    assert.ok(!events.includes('READINESS:started'), 'readiness never starts after the abort');
    assert.ok(events.indexOf('trial_interrupted') > events.indexOf('PROVISIONING:succeeded'));
    assert.deepEqual(reasonCodes(world, 'LATE_MONITORING', 'skipped'), ['EXECUTION_INTERRUPTED']);
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
    assert.equal(outcome.interruption?.cause, 'OPERATOR_ABORT');
  });

  it('fails cleanup planning for a resource manifest of another execution, and marks the lease for recovery', async () => {
    const world = await RunnerWorld.create({
      deps: (built) => {
        const manifest = JSON.parse(new TextDecoder().decode(built.resourceManifestBytes)) as JsonObject;
        const foreign = { ...manifest, run_id: '0f0f0f0f-0000-4000-8000-000000000001' };
        return {
          provisioner: new OfflineProvisioner({
            bytes: new TextEncoder().encode(JSON.stringify(foreign)),
            log: built.account.log,
          }),
        };
      },
    });
    const outcome = await world.run();
    assert.deepEqual(reasonCodes(world, 'CLEANUP', 'failed'), ['OWNERSHIP_CONTEXT_INVALID']);
    assert.equal(outcome.cleanup_status, undefined);
    assert.equal(outcome.lease_status, 'recovery_required');
    assert.deepEqual(world.lease.calls().slice(-1), ['finalize:unclean']);
    assert.equal(outcome.package_finalized, true);
  });
});

describe('ExecutionRunner P3: readiness', () => {
  it('runs no trial when a mapping never reports Enabled, and skips monitoring', async () => {
    const trials = new ScriptedTrialRunner();
    const world = await RunnerWorld.create({
      deps: (built) => ({
        trials,
        provisioner: new OfflineProvisioner({
          bytes: built.resourceManifestBytes,
          targets: { ...targetsOf(built.cloud.execution), event_source_mapping_ids: ['missing-mapping'] },
          log: built.account.log,
        }),
      }),
    });
    const outcome = await world.run();
    assert.deepEqual(reasonCodes(world, 'READINESS', 'failed'), ['EVENT_SOURCE_MAPPING_NOT_ENABLED']);
    assert.deepEqual(reasonCodes(world, 'LATE_MONITORING', 'skipped'), ['LATE_MONITORING_NOT_REACHED']);
    assert.ok(!world.runnerEvents().includes('TRIALS:started'));
    assert.deepEqual(trials.plans(), []);
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
    assert.equal(outcome.interruption, undefined);
  });

  it('reports an interruption that arrived while readiness waited', async () => {
    const world = await RunnerWorld.create({
      deps: (built) => ({
        provisioner: new OfflineProvisioner({
          bytes: built.resourceManifestBytes,
          targets: { ...targetsOf(built.cloud.execution), event_source_mapping_ids: ['missing-mapping'] },
          log: built.account.log,
        }),
      }),
    });
    world.cloud.time.schedule(30_000, () => {
      world.lease.lose();
    });
    const outcome = await world.run();
    assert.deepEqual(reasonCodes(world, 'READINESS', 'failed'), [
      'EVENT_SOURCE_MAPPING_NOT_ENABLED',
      'EXECUTION_INTERRUPTED',
    ]);
    assert.equal(outcome.interruption?.cause, 'LEASE_LOST');
    assert.match(outcome.interruption.detail, /^LOST_OWNERSHIP_MISMATCH: /);
  });

  it('runs no trial when the execution configuration cannot be written for the controller', async () => {
    const trials = new ScriptedTrialRunner();
    const world = await RunnerWorld.create({ deps: () => ({ trials }) });
    world.cloud.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'ValidationException' },
      { table: 'control' },
    );
    await world.run();
    assert.deepEqual(reasonCodes(world, 'READINESS', 'failed'), ['EXECUTION_CONFIGURATION_NOT_WRITTEN']);
    assert.deepEqual(trials.plans(), []);
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
  });
});

describe('ExecutionRunner P4: trials', () => {
  it('runs no trial when one cannot be planned', async () => {
    const trials = new ScriptedTrialRunner();
    const world = await RunnerWorld.create({
      deps: (built) => {
        const { durable_caller: _caller, ...targets } = targetsOf(built.cloud.execution);
        return {
          trials,
          provisioner: new OfflineProvisioner({ bytes: built.resourceManifestBytes, targets, log: built.account.log }),
        };
      },
    });
    const outcome = await world.run();
    assert.deepEqual(reasonCodes(world, 'TRIALS', 'failed'), ['TRIAL_TARGETS_MISSING']);
    assert.deepEqual(trials.plans(), []);
    assert.deepEqual(
      outcome.reasons.map((reason) => reason.code),
      ['TRIAL_TARGETS_MISSING'],
    );
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'EMERGENCY');
  });

  it('records trials that did not freeze, then monitors and cleans up normally', async () => {
    const trials = new ScriptedTrialRunner('freeze_failed');
    const world = await RunnerWorld.create({ deps: () => ({ trials }) });
    const outcome = await world.run();
    assert.equal(trials.plans().length, 4);
    assert.deepEqual(reasonCodes(world, 'TRIALS', 'failed'), [
      'TRIAL_FREEZE_FAILED',
      'TRIAL_FREEZE_FAILED',
      'TRIAL_FREEZE_FAILED',
      'TRIAL_FREEZE_FAILED',
    ]);
    assert.ok(world.runnerEvents().includes('LATE_MONITORING:succeeded'));
    assert.equal(world.record(EXECUTION_PATHS.cleanupResult)['cleanup_mode'], 'NORMAL');
    assert.equal(outcome.lease_status, 'released');
  });
});

describe('ExecutionRunner P8: the lease is finalized', () => {
  it('fails the phase when the final lease status cannot be verified', async () => {
    const lease = new ScriptedExecutionLease({ finalStatus: 'unverified' });
    const world = await RunnerWorld.create({ deps: () => ({ lease, trials: new ScriptedTrialRunner() }) });
    const outcome = await world.run();
    assert.ok(world.runnerEvents().includes('LEASE_FINALIZATION:failed'));
    assert.equal(outcome.lease_status, 'unverified');
  });
});
