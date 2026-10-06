// Cleanup steps 1 and 2 over a package whose trials really froze (design §10.4; BR-RUA-043,
// BR-RUA-049): step 1 re-reads the settled offline cloud and writes the empty late stream once, step 2 freezes one assessment over every
// trial that froze an oracle result, and an unreadable package, an oracle result without a readable
// trial manifest, an oracle result the assessment rejects and a file already written each fail the
// step with a reason instead of a partial assessment.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionGate } from '../../../src/execution-lifecycle/execution-gate.ts';
import { ExecutionPackage } from '../../../src/execution-lifecycle/execution-package.ts';
import { LateEvidenceFreeze } from '../../../src/execution-lifecycle/late-evidence-freeze.ts';
import { LateEvidenceMonitor } from '../../../src/execution-lifecycle/late-monitoring.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { SelfAdvancingSleeper } from '../../support/cleanup/self-advancing-sleeper.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { ScriptedExecutionLease } from './fakes/scripted-execution-lease.ts';
import { ScriptedExecutionSafety } from './fakes/scripted-execution-safety.ts';
import { lifecycleServices, lifecycleValidator, targetsOf } from './support/execution-fixtures.ts';
import { RunnerWorld } from './support/runner-world.ts';

// Areas written after the last trial froze; the package below stops at that point.
const AFTER_TRIALS = ['late-evidence/', 'cleanup/', 'summary/', EXECUTION_PATHS.packageIndex];

const finished = await RunnerWorld.create();
await finished.run();
const { admitted } = finished;
const { identity } = admitted;
const directory = admitted.package_directory;
const [firstTrial] = admitted.manifest.trials;
assert.ok(identity.execution_kind === 'RUN' && firstTrial !== undefined, 'the run fixture declares trials');
const { store, dlqReceiver: dlq, durable } = finished.cloud;
const TARGETS = targetsOf(finished.cloud.execution);
const firstUnit = { kind: 'trial', trial_id: firstTrial.trial_id } as const;
const FROZEN = new Map(
  [...finished.cloud.packageFiles()].filter(([path]) => !AFTER_TRIALS.some((prefix) => path.startsWith(prefix))),
);

interface LateWorld {
  readonly storage: OfflinePackageStorage;
  readonly steps: LateEvidenceFreeze;
}

// The trials' package, edited, behind steps whose monitoring window completed.
async function lateWorld(edit: (files: Map<string, Uint8Array>) => void = () => undefined): Promise<LateWorld> {
  const files = new Map(FROZEN);
  edit(files);
  const storage = new OfflinePackageStorage();
  for (const [path, bytes] of files) {
    await storage.writeOnce(`${directory}/${path}`, bytes);
  }
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12, 40, 0, 0) });
  const services = lifecycleServices(time, new SelfAdvancingSleeper(time)).services;
  const monitor = new LateEvidenceMonitor(services);
  const gate = new ExecutionGate(new ScriptedExecutionLease());
  gate.arm(new ScriptedExecutionSafety());
  await monitor.observe(gate);
  const pkg = new ExecutionPackage(storage, admitted.identity, directory);
  return {
    storage,
    steps: new LateEvidenceFreeze({
      admitted,
      pkg,
      monitor,
      capture: { store, dlq, durable },
      targets: TARGETS,
      services,
    }),
  };
}

function codes(reasons: readonly { readonly code: string }[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}

describe('LateEvidenceFreeze', () => {
  it('writes the empty stream, then freezes one assessment over every frozen trial', async () => {
    const { storage, steps } = await lateWorld();
    assert.deepEqual(await steps.cutoff(), { status: 'succeeded', reasons: [] });
    assert.deepEqual(await steps.freezeAssessment(), { status: 'succeeded', reasons: [] });
    const files = storage.filesUnder(directory);
    assert.deepEqual(files.get(EXECUTION_PATHS.lateEvidenceStream), new Uint8Array());
    const assessment = JSON.parse(
      new TextDecoder().decode(files.get(EXECUTION_PATHS.lateEvidenceAssessment)),
    ) as JsonObject;
    assert.equal(lifecycleValidator().validate(assessment as JsonValue).valid, true);
    assert.equal(assessment['execution_manifest_sha256'], admitted.manifest_sha256);
  });

  it('fails the cutoff over a stream already written', async () => {
    const { steps } = await lateWorld((files) => files.set(EXECUTION_PATHS.lateEvidenceStream, new Uint8Array([1])));
    const report = await steps.cutoff();
    assert.equal(report.status, 'failed');
    assert.deepEqual(codes(report.reasons), ['PACKAGE_FILE_NOT_WRITTEN']);
  });

  it('fails the assessment over a package it cannot list', async () => {
    const { storage, steps } = await lateWorld();
    storage.failNextLists(1);
    const report = await steps.freezeAssessment();
    assert.equal(report.status, 'failed');
    assert.deepEqual(codes(report.reasons), ['PACKAGE_UNREADABLE']);
  });

  it('names an oracle result whose trial manifest is absent', async () => {
    const { steps } = await lateWorld((files) => files.delete(PACKAGE_LAYOUT.unitFile(firstUnit, 'trialManifest')));
    const report = await steps.freezeAssessment();
    assert.equal(report.status, 'failed');
    assert.deepEqual(codes(report.reasons), ['FROZEN_TRIAL_INPUT_UNREADABLE']);
    assert.match(report.reasons[0]?.detail ?? '', /trial-manifest\.json is absent; expected/);
  });

  it('names an oracle result whose trial manifest is unreadable', async () => {
    const { steps } = await lateWorld((files) =>
      files.set(PACKAGE_LAYOUT.unitFile(firstUnit, 'trialManifest'), new TextEncoder().encode('{"record_type":1}\n')),
    );
    const report = await steps.freezeAssessment();
    assert.deepEqual(codes(report.reasons), ['FROZEN_TRIAL_INPUT_UNREADABLE']);
    assert.doesNotMatch(report.reasons[0]?.detail ?? '', / is absent;/);
  });

  it('fails an assessment over an oracle result it cannot read, writing none', async () => {
    const { storage, steps } = await lateWorld((files) =>
      files.set(PACKAGE_LAYOUT.unitFile(firstUnit, 'oracleResult'), new TextEncoder().encode('not json\n')),
    );
    const report = await steps.freezeAssessment();
    assert.equal(report.status, 'failed');
    assert.ok(report.reasons.length > 0);
    assert.equal(storage.filesUnder(directory).has(EXECUTION_PATHS.lateEvidenceAssessment), false);
  });

  it('fails over an assessment already written', async () => {
    const { steps } = await lateWorld((files) =>
      files.set(EXECUTION_PATHS.lateEvidenceAssessment, new Uint8Array([1])),
    );
    const report = await steps.freezeAssessment();
    assert.equal(report.status, 'failed');
    assert.deepEqual(codes(report.reasons), ['PACKAGE_FILE_NOT_WRITTEN']);
  });
});
