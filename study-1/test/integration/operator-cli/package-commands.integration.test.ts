// The read-only package commands over a package the real execution runner finalized offline
// (design §10.2 P1-P9 in the offline cloud, §11): `oracle evaluate` re-evaluates each frozen trial
// from the stored bytes and reaches the verdict projection the trial froze (CF "the oracle is a
// pure function of bytes", D-16), and `run verify` / `validation verify` read the package back
// through the evidence file system and write their outputs under `verifications/`, never inside
// the package. No AWS.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT, executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import { main } from '../../../src/operator-cli/cli-main.ts';
import type { CliCommand } from '../../../src/operator-cli/cli-types.ts';
import { OracleEvaluateCommand } from '../../../src/operator-cli/oracle-evaluate-command.ts';
import { RunVerifyCommand } from '../../../src/operator-cli/run-verify-command.ts';
import { ValidationVerifyCommand } from '../../../src/operator-cli/verify-commands.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { CliResult } from '../../../src/record-contract/records/group-c/cli_result.ts';
import type { OracleResult } from '../../../src/record-contract/records/group-c/oracle_result.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { verdictProjection } from '../../../src/trial-oracle/verdict-projection.ts';
import type { VerdictProjection } from '../../../src/trial-oracle/verdict-projection.ts';
import { RunnerWorld } from '../execution-lifecycle/support/runner-world.ts';
import { harnessRoot } from '../../unit/operator-cli/support/cli-harness.ts';
import { ScriptedQualificationReader } from '../../unit/operator-cli/support/scripted-qualification-reader.ts';

const validator = createRecordValidator();
const EVIDENCE = '/operator/evidence';

interface Invocation {
  readonly exit_code: number;
  readonly result: CliResult;
}

async function invoke(argv: readonly string[], commands: readonly CliCommand[]): Promise<Invocation> {
  const lines: string[] = [];
  const exitCode = await main(
    [...argv, '--evidence-root', EVIDENCE],
    { stdout: (line) => lines.push(line), stderr: () => undefined },
    harnessRoot(commands),
  );
  assert.equal(lines.length, 1);
  return { exit_code: exitCode, result: JSON.parse(lines[0] ?? '') as CliResult };
}

// The verdict projection D-16 compares. The runner journal is execution-level and keeps growing
// after a trial froze, so references to it carry its current digest; the projection does not.
function projectionOf(result: JsonObject): VerdictProjection {
  return verdictProjection(result as unknown as OracleResult);
}

describe('package commands over an offline-finalized package', () => {
  it('oracle evaluate re-evaluates every frozen trial of a run to the projection it froze', async () => {
    const world = await RunnerWorld.create();
    const outcome = await world.run();
    assert.equal(outcome.package_finalized, true);
    const storage = world.cloud.storage;
    const command = new OracleEvaluateCommand({
      files: (): PackageFileSystem => storage,
      validator,
      clock: world.cloud.time,
    });
    const directory = PACKAGE_LAYOUT.executionDirectory(world.admitted.identity);
    for (const trial of world.admitted.manifest.trials) {
      const unit = { kind: 'trial', trial_id: trial.trial_id } as const;
      const frozen = world.record(PACKAGE_LAYOUT.unitFile(unit, 'oracleResult'));
      const { exit_code: exitCode, result } = await invoke(
        ['oracle', 'evaluate', `${EVIDENCE}/${directory}/${PACKAGE_LAYOUT.unitDirectory(unit)}`],
        [command],
      );
      assert.equal(exitCode, 0, JSON.stringify(result.reasons));
      assert.equal(result.outcome, 'completed');
      assert.deepEqual(result.written_paths, []);
      assert.ok(result.result_record !== undefined);
      assert.equal(validator.validateAs('oracle_result', result.result_record).valid, true);
      assert.deepEqual(projectionOf(result.result_record), projectionOf(frozen));
    }
  });

  it('run verify writes its outputs beside the package and leaves the package unchanged', async () => {
    const world = await RunnerWorld.create();
    await world.run();
    const storage = world.cloud.storage;
    const before = world.cloud.packageFiles();
    const qualification = world.admitted.manifest.qualification;
    assert.ok(qualification !== null);
    const command = new RunVerifyCommand({
      files: (): PackageFileSystem => storage,
      validator,
      clock: world.cloud.time,
      qualifications: new ScriptedQualificationReader(),
    });
    const directory = PACKAGE_LAYOUT.executionDirectory(world.admitted.identity);
    const { exit_code: exitCode, result } = await invoke(
      [
        'run',
        'verify',
        `${EVIDENCE}/${directory}`,
        '--probe',
        qualification.transport_probe_id,
        '--probe-index',
        qualification.original_package_index_sha256,
      ],
      [command],
    );
    assert.ok(exitCode === 0 || exitCode === 5, String(exitCode));
    const id = executionIdOf(world.admitted.identity);
    assert.deepEqual(
      result.written_paths.map((path) => path.replace(/\/\d{4}-\d{2}-\d{2}T[\d:.]+Z-/, '/<at>-')),
      [
        `verifications/${id}/<at>-package-verification.json`,
        `verifications/${id}/<at>-study-completion-assessment.json`,
      ],
    );
    for (const path of result.written_paths) {
      const stored = await storage.read(path);
      assert.equal(stored.ok, true, path);
    }
    assert.deepEqual(world.cloud.packageFiles(), before);
    assert.equal(result.result_record?.['record_type'], 'study_completion_assessment');
  });

  it('validation verify reads the runner-written summary and writes its outputs beside the package', async () => {
    // Since CMP-05 the runner binds the summary writer of its own kind (summaryWriterFor), so a
    // validation package carries its validation summary. The offline package is still ineligible
    // to the package verifier (the runner journal grows after the results cite its freeze-time
    // digest: the CMP-05 finding recorded in evidence/WP-28/decisions.md), so the answer is exit 5
    // with the verifier's reasons, written under `verifications/`, never inside the package.
    const world = await RunnerWorld.create({ name: 'validation-conventional' });
    await world.run();
    assert.ok(world.file(EXECUTION_PATHS.validationSummary) !== undefined);
    const storage = world.cloud.storage;
    const before = world.cloud.packageFiles();
    const command = new ValidationVerifyCommand({
      files: (): PackageFileSystem => storage,
      validator,
      clock: world.cloud.time,
    });
    const directory = PACKAGE_LAYOUT.executionDirectory(world.admitted.identity);
    const { exit_code: exitCode, result } = await invoke(
      ['validation', 'verify', `${EVIDENCE}/${directory}`],
      [command],
    );
    assert.equal(exitCode, 5);
    assert.equal(result.outcome, 'verification_failed');
    assert.equal(result.reasons[0]?.code, 'PACKAGE_INELIGIBLE');
    const id = executionIdOf(world.admitted.identity);
    assert.deepEqual(
      result.written_paths.map((path) => path.replace(/\/\d{4}-\d{2}-\d{2}T[\d:.]+Z-/, '/<at>-')),
      [`verifications/${id}/<at>-variant-validation-verification.json`],
    );
    for (const path of result.written_paths) {
      assert.equal((await storage.read(path)).ok, true, path);
    }
    assert.deepEqual(world.cloud.packageFiles(), before);
  });
});
