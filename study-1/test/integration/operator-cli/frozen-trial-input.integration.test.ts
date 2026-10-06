// Rebuilding a frozen trial's ingestion input from a package the execution runner finalized
// offline, and `oracle evaluate`'s refusals (design §8.2 I3, D-16, §11): the input holds the
// trial's own files without what was derived from them, the execution-level files of freeze time,
// the earlier trials as execution scope and the evidence index's digests; every missing or
// unreadable input is a reason naming its path; a trial directory that names no trial is a usage
// error. No AWS.

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { frozenTrialInput } from '../../../src/operator-cli/frozen-trial-input.ts';
import { OracleEvaluateCommand, locateTrial } from '../../../src/operator-cli/oracle-evaluate-command.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { RunnerWorld } from '../execution-lifecycle/support/runner-world.ts';
import { HARNESS_NOW, runCli } from '../../unit/operator-cli/support/cli-harness.ts';
import { STORED_EVIDENCE_ROOT, storePackage } from '../../unit/operator-cli/support/stored-packages.ts';

const validator = createRecordValidator();
const clock = new VirtualTimeScheduler({ wallEpochMs: Date.parse(HARNESS_NOW) });
const OTHER_ID = '0b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b' as Uuid4;

describe('frozen trial inputs of an offline-finalized run', () => {
  let world: RunnerWorld;
  let files: readonly PackageFile[];
  let trials: readonly Uuid4[];

  before(async () => {
    world = await RunnerWorld.create();
    await world.run();
    files = [...world.cloud.packageFiles()].map(([path, bytes]) => ({ path, bytes }));
    trials = world.admitted.manifest.trials.map((trial) => trial.trial_id);
  });

  function trialDirectory(trialId: Uuid4): string {
    return `${PACKAGE_LAYOUT.unitDirectory({ kind: 'trial', trial_id: trialId })}/`;
  }

  function replaced(path: string, bytes: Uint8Array | undefined): readonly PackageFile[] {
    const kept = files.filter((file) => file.path !== path);
    return bytes === undefined ? kept : [...kept, { path, bytes }];
  }

  it('composes the subject, the freeze-time execution files, the earlier trials and the index digests', () => {
    const subject = trials[2] ?? OTHER_ID;
    const input = frozenTrialInput(files, subject, validator);
    assert.equal(input.ok, true);
    const artifactPaths = input.value.artifacts.map((file) => file.path);
    assert.ok(artifactPaths.includes(PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: subject }, 'trialManifest')));
    assert.ok(artifactPaths.includes(EXECUTION_PATHS.executionManifest));
    assert.ok(!artifactPaths.some((path) => path.startsWith(`${trialDirectory(subject)}derived/`)));
    assert.ok(!artifactPaths.includes(PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: subject }, 'evidenceIndex')));
    assert.ok(!artifactPaths.some((path) => /^(late-evidence|cleanup|summary|readiness|provider)\//.test(path)));
    assert.ok(!artifactPaths.some((path) => path.startsWith('trials/') && !path.startsWith(trialDirectory(subject))));
    const scope = new Set(input.value.execution_scope_artifacts.map((file) => file.path.split('/')[1]));
    assert.deepEqual([...scope].toSorted(), trials.slice(0, 2).toSorted());
    assert.ok(input.value.indexed_digests !== undefined && input.value.indexed_digests.size > 0);
    assert.ok(input.value.expected.length > 0);
  });

  it('gives the first trial no execution scope', () => {
    const input = frozenTrialInput(files, trials[0] ?? OTHER_ID, validator);
    assert.deepEqual(input.ok && input.value.execution_scope_artifacts, []);
  });

  it('names each input it cannot read', () => {
    const subject = trials[0] ?? OTHER_ID;
    const unit = { kind: 'trial', trial_id: subject } as const;
    const manifestPath = PACKAGE_LAYOUT.unitFile(unit, 'trialManifest');
    const indexPath = PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex');
    const cases: readonly (readonly [readonly PackageFile[], Uuid4, string])[] = [
      [
        replaced(EXECUTION_PATHS.executionManifest, undefined),
        subject,
        `${EXECUTION_PATHS.executionManifest} is absent; expected the frozen execution manifest`,
      ],
      [
        files,
        OTHER_ID,
        `${EXECUTION_PATHS.executionManifest} declares no trial ${OTHER_ID}; expected one of the declared trials [${trials.join(', ')}]`,
      ],
      [
        replaced(manifestPath, undefined),
        subject,
        `${manifestPath} is absent; expected the trial's frozen trial_manifest`,
      ],
      [
        replaced(manifestPath, utf8('{')),
        subject,
        `${manifestPath} is not a valid record; expected one UTF-8 JSON trial_manifest document`,
      ],
      [
        replaced(indexPath, utf8('{"record_type":"evidence_index"}')),
        subject,
        `${indexPath} is not a valid record; expected one UTF-8 JSON evidence_index document`,
      ],
    ];
    for (const [packageFiles, trialId, detail] of cases) {
      assert.deepEqual(frozenTrialInput(packageFiles, trialId, validator), {
        ok: false,
        error: { code: 'FROZEN_TRIAL_INPUT_UNREADABLE', subject: 'CTR-RUA-001', detail },
      });
    }
    const unreadable = frozenTrialInput(replaced(EXECUTION_PATHS.executionManifest, utf8('[]')), subject, validator);
    assert.equal(unreadable.ok, false);
    assert.notEqual(unreadable.error.code, 'FROZEN_TRIAL_INPUT_UNREADABLE');
  });

  it('oracle evaluate refuses what it cannot evaluate', async () => {
    const identity = world.admitted.identity;
    const subject = trials[0] ?? OTHER_ID;
    const operand = `${STORED_EVIDENCE_ROOT}/${PACKAGE_LAYOUT.executionDirectory(identity)}/trials/${subject}`;
    const evaluate = async (fs: MemoryPackageFileSystem): Promise<Awaited<ReturnType<typeof runCli>>> =>
      runCli(
        ['oracle', 'evaluate', operand, '--evidence-root', STORED_EVIDENCE_ROOT],
        [new OracleEvaluateCommand({ files: (): PackageFileSystem => fs, validator, clock })],
      );
    const missing = await evaluate(new MemoryPackageFileSystem());
    assert.equal(missing.exit_code, 5);
    assert.equal(missing.result.reasons[0]?.code, 'PACKAGE_UNREADABLE');
    const unit = { kind: 'trial', trial_id: subject } as const;
    const noIndex = await evaluate(
      await storePackage(identity, replaced(PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex'), undefined)),
    );
    assert.equal(noIndex.exit_code, 5);
    assert.equal(noIndex.result.run_id, identity.execution_kind === 'RUN' ? identity.run_id : undefined);
    assert.equal(noIndex.result.reasons[0]?.code, 'FROZEN_TRIAL_INPUT_UNREADABLE');
    // Another trial's manifest in this trial's directory: the expected artifacts are that trial's,
    // which are not this trial's evidence, so the evidence names no trial and the oracle refuses.
    const manifestPath = PACKAGE_LAYOUT.unitFile(unit, 'trialManifest');
    const otherManifest = world.file(
      PACKAGE_LAYOUT.unitFile({ kind: 'trial', trial_id: trials[1] ?? OTHER_ID }, 'trialManifest'),
    );
    const refused = await evaluate(await storePackage(identity, replaced(manifestPath, otherManifest)));
    assert.equal(refused.exit_code, 5, JSON.stringify(refused.result.reasons));
    assert.equal(refused.result.reasons[0]?.subject, 'CTR-RUA-001');
  });
});

describe('locateTrial', () => {
  const root = '/operator/evidence';
  const runId = '1b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b';
  const trialId = '2b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b';

  it('names the execution and the trial of a run or validation trial directory', () => {
    assert.deepEqual(locateTrial(root, `${root}/runs/${runId}/trials/${trialId}`), {
      ok: true,
      value: { execution: { execution_kind: 'RUN', run_id: runId }, trial_id: trialId },
    });
    assert.deepEqual(locateTrial(root, `${root}/variant-validations/${runId}/trials/${trialId}`), {
      ok: true,
      value: { execution: { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: runId }, trial_id: trialId },
    });
  });

  it('refuses every other directory', () => {
    for (const path of [
      `${root}/transport-probes/${runId}/trials/${trialId}`,
      `${root}/runs/${runId}/probe/${trialId}`,
      `${root}/runs/${runId}/trials/not-a-uuid`,
      `${root}/runs/nope/trials/${trialId}`,
      `${root}/runs/${runId}`,
    ]) {
      const located = locateTrial(root, path);
      assert.equal(located.ok, false, path);
      assert.equal(
        located.error.detail,
        `trial directory ${JSON.stringify(path)} names no trial; expected <evidence-root>/{runs|variant-validations}/<execution_id>/trials/<trial_id>`,
      );
    }
  });

  it('is a usage error of the command', async () => {
    const run = await runCli(
      ['oracle', 'evaluate', `${root}/runs/${runId}`, '--evidence-root', root],
      [new OracleEvaluateCommand({ files: (): PackageFileSystem => new MemoryPackageFileSystem(), validator, clock })],
    );
    assert.equal(run.exit_code, 2);
  });
});
