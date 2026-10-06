// AC-RUA-008 Controlled Repetition (BR-RUA-019, BR-RUA-028, BR-RUA-040, BR-RUA-042): admission
// freezes every declared field before the first mutation, the runner executes exactly those
// frozen bytes (four trials in declared order, fresh identities, partitions asserted absent), every
// result names their digest, and a changed declared field means a new execution identity.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readAdmittedExecution } from '../../../src/execution-lifecycle/admitted-execution.ts';
import { RunSummaryWriter } from '../../../src/execution-lifecycle/execution-finalization.ts';
import type { AdmittedTrialExecution } from '../../../src/execution-lifecycle/execution-ports.ts';
import { ExecutionRunner } from '../../../src/execution-lifecycle/execution-runner.ts';
import { SessionExecutionLease } from '../../../src/execution-lifecycle/session-lease.ts';
import { asTrialExecution } from '../../../src/execution-lifecycle/trial-plans.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { RUN_SAFETY } from '../../../src/safety/safety-limits.ts';
import { SafetySupervisor } from '../../../src/safety/safety-supervisor.ts';
import { stackName } from '../../../infra/ownership/resource-naming.ts';
import { financialRecords } from '../../support/admission/admission-fixtures.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';
import { resourceManifest, runTags } from '../../support/cleanup/cleanup-fixtures.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { ScriptedDurableExecutionReader } from '../../support/evidence-collection/scripted-durable-execution-reader.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { OfflineQueueCounterReader } from '../../support/offline-cloud/offline-queue-counter-reader.ts';
import { OfflineProvisioner } from './fakes/offline-provisioner.ts';
import { ScriptedTrialRunner } from './fakes/scripted-trial-runner.ts';
import { filesNamingADigest, manifestDigestsNamed } from './support/digest-references.ts';
import { lifecycleServices, lifecycleValidator } from './support/execution-fixtures.ts';
import { cleanupBindings, offlineAccount } from './support/offline-account.ts';
import { RunnerWorld } from './support/runner-world.ts';
import { driveUntilSettled } from './support/virtual-drive.ts';

const AFTER_ADMISSION_MS = Date.parse('2026-10-06T09:10:00.000Z');

interface AdmittedHarnessRun {
  readonly harness: AdmissionHarness;
  readonly admitted: AdmittedTrialExecution;
  readonly manifestBytes: Uint8Array;
  readonly storage: OfflinePackageStorage;
}

// Admits a run through the real admission over its fakes and copies the frozen package into the
// evidence root the runner writes, exactly as admission left it.
async function admittedHarnessRun(): Promise<AdmittedHarnessRun> {
  const harness = await AdmissionHarness.create('RUN');
  const admission = await harness.admit();
  assert.equal(admission.kind, 'admitted');
  const manifestBytes = await harness.evidenceFile(admission.manifest_path);
  const read = readAdmittedExecution(manifestBytes, lifecycleValidator());
  const admitted = read.ok ? asTrialExecution(read.value) : undefined;
  assert.ok(admitted !== undefined);
  assert.equal(admitted.manifest_sha256, admission.manifest_sha256);
  const storage = new OfflinePackageStorage();
  for (const path of await harness.packagePaths()) {
    const written = await storage.writeOnce(path, await harness.evidenceFile(path));
    assert.ok(written.ok);
  }
  return { harness, admitted, manifestBytes, storage };
}

// The runner over the admitted run: the real coordination lease on the harness's lease store,
// and a deploy that fails (P2 is a recorded mutation), so emergency cleanup follows.
function harnessRunner(run: AdmittedHarnessRun, time: VirtualTimeScheduler): ExecutionRunner {
  const { harness, admitted, storage } = run;
  const { services } = lifecycleServices(time);
  const executionId = admitted.identity.execution_kind === 'RUN' ? admitted.identity.run_id : undefined;
  assert.ok(executionId !== undefined);
  const failed = {
    ...resourceManifest('failed', {
      identity: { run_id: executionId },
      tags: runTags(executionId),
      members: [],
      withStack: false,
    }),
    execution_manifest_sha256: admitted.manifest_sha256,
    stack_name: stackName('RUN', executionId),
  };
  const account = offlineAccount(failed, harness.mutationLog);
  const store = new InMemoryItemStore({ clock: time });
  return new ExecutionRunner(admitted, {
    lease: new SessionExecutionLease(admitted, { store: harness.lease, journals: storage, scheduler: time, services }),
    provisioner: new OfflineProvisioner({
      bytes: serializeRecordFile(failed),
      log: harness.mutationLog,
      files: storage,
    }),
    readiness: { consumers: account.consumers },
    trials: new ScriptedTrialRunner(),
    safety: (startedNs) => new SafetySupervisor({ monotonic: time, wall: time, limits: RUN_SAFETY, startedNs }),
    cleanup: cleanupBindings(account, store, time),
    readers: { store, queues: new OfflineQueueCounterReader(new Map()), durable: new ScriptedDurableExecutionReader() },
    evidence: { files: storage, journals: storage },
    summary: new RunSummaryWriter(lifecycleValidator()),
    services,
  });
}

describe('AC-RUA-008 controlled repetition', () => {
  it('ac008-declared-fields-frozen-before-first-mutation', async () => {
    const run = await admittedHarnessRun();
    const { harness, admitted, manifestBytes, storage } = run;
    assert.ok(harness.mutationLog.isEmpty(), 'admission mutates nothing in the account');
    const time = new VirtualTimeScheduler({ wallEpochMs: AFTER_ADMISSION_MS });
    const outcome = await driveUntilSettled(() => time.advanceBy(1000), harnessRunner(run, time).run());
    assert.equal(outcome.package_finalized, true);

    const mutations = harness.mutationLog.entries();
    assert.equal(mutations[0]?.target, 'coordination', 'the first mutation is the lease acquisition');
    const deploy = harness.mutationLog.firstSequenceOf('cloudformation', 'CreateStack');
    assert.ok(deploy !== undefined && deploy > 1);
    const lease = await harness.lease.read();
    assert.ok(lease.ok && lease.value !== undefined);
    assert.equal(lease.value.owner_manifest_sha256, admitted.manifest_sha256, 'the lease owner is the frozen manifest');
    assert.equal(lease.value.lease_status, 'RELEASED', 'a failed deploy that left nothing releases the lease');

    const files = storage.filesUnder(admitted.package_directory);
    assert.deepEqual(files.get(EXECUTION_PATHS.executionManifest), manifestBytes, 'the frozen bytes never change');
    assert.deepEqual([...manifestDigestsNamed(files)], [admitted.manifest_sha256]);
    assert.ok(filesNamingADigest(files) >= 8);
  });

  it('ac008-four-trials-declared-order-fresh-partitions', async () => {
    const world = await RunnerWorld.create();
    const outcome = await world.run();
    const declared = world.admitted.manifest.trials.map((trial) => trial.trial_id);
    assert.equal(declared.length, 4);
    assert.equal(new Set(declared).size, 4, 'every trial has a fresh identity');
    assert.deepEqual(
      outcome.trials.map((report) => [report.kind, report.trial_id]),
      declared.map((trialId) => ['frozen', trialId]),
    );
    assert.deepEqual(
      world.admitted.manifest.trials.map((trial) => trial.sequence),
      [1, 2, 3, 4],
    );

    const events = world.journal(EXECUTION_PATHS.runnerJournal);
    for (const trialId of declared) {
      const own = events.filter((event) => event['trial_id'] === trialId).map((event) => event['record_type']);
      assert.ok(own.includes('trial_partitions_verified_absent'), `${trialId} asserted its partitions absent`);
      assert.ok(own.indexOf('trial_partitions_verified_absent') < own.indexOf('trial_message_published'));
    }
    const published = events.filter((event) => event['record_type'] === 'trial_message_published');
    assert.deepEqual(
      published.map((event) => event['trial_id']),
      declared,
      'published in the declared order',
    );

    const files = world.cloud.packageFiles();
    for (const trialId of declared) {
      const manifest = world.record(`trials/${trialId}/trial-manifest.json`);
      assert.equal(manifest['execution_manifest_sha256'], world.admitted.manifest_sha256);
    }
    assert.deepEqual([...manifestDigestsNamed(files)], [world.admitted.manifest_sha256]);
    assert.equal(outcome.lease_status, 'released');
    assert.ok(files.has(EXECUTION_PATHS.packageIndex));
  });

  it('ac008-changed-field-new-identity', async () => {
    const harness = await AdmissionHarness.create('RUN');
    const first = await harness.admit();
    const firstBytes = first.kind === 'admitted' ? await harness.evidenceFile(first.manifest_path) : undefined;
    harness.request = {
      ...harness.request,
      financial_inputs: financialRecords({ captured_amount_minor: 20000 }, { approved_amount_minor: 20000 }),
    };
    const second = await harness.admit();
    assert.ok(first.kind === 'admitted' && second.kind === 'admitted');
    assert.notDeepEqual(second.execution, first.execution, 'a changed field is a new execution');
    assert.notEqual(second.manifest_sha256, first.manifest_sha256);
    assert.notEqual(second.manifest_path, first.manifest_path);
    assert.deepEqual(await harness.evidenceFile(first.manifest_path), firstBytes, 'the first freeze is untouched');
    const read = readAdmittedExecution(await harness.evidenceFile(second.manifest_path), lifecycleValidator());
    assert.ok(read.ok);
    assert.equal(read.value.manifest.financial_inputs.captured_amount_minor, 20000);
  });
});
