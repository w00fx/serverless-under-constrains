// AC-RUA-055 (BR-RUA-055, design §14 row 055, D-18): `rua oracle revision-check` runs the oracle's
// real golden suite at a source revision of this repository, in a temporary git worktree of a
// clone, and passes only when every verdict-changing rule's golden cases pass there. The clone gets
// one extra commit that seeds a regression into the oracle (a failing business rule no longer
// fails the BR-RUA-006 verdict); at that commit the check must fail. The third case checks out the
// revision a canonical run's frozen manifest recorded (AC-RUA-055 "its recorded source revision").
// Local git and npm only; no AWS.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { main } from '../../../src/operator-cli/cli-main.ts';
import { createCompositionRoot } from '../../../src/operator-cli/composition-root.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { ExecutionManifest } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { CliResult } from '../../../src/record-contract/records/group-c/cli_result.ts';
import type { OracleRevisionCheck } from '../../../src/record-contract/records/group-c/oracle_revision_check.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { VERDICT_CHANGING_RULES } from '../../../src/trial-oracle/oracle-vocabulary.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';

const STUDY_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const GIT_IDENTITY = ['-c', 'user.name=Study Operator', '-c', 'user.email=operator@example.invalid'];
const VERDICT_SOURCE = 'study-1/src/trial-oracle/preservation-verdict.ts';
const VERDICT_FAILS = "if (business.some((rule) => rule.result === 'fail')) {\n    return 'fail';";
const VERDICT_REGRESSED = "if (business.some((rule) => rule.result === 'fail')) {\n    return 'pass';";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim();
}

interface Invocation {
  readonly exit_code: number;
  readonly result: CliResult;
  readonly record: OracleRevisionCheck | undefined;
}

describe('AC-RUA-055 oracle revision check', () => {
  let scratch: string;
  let clone: string;
  let base: string;
  let baseTree: string;
  let regressed: string;

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'rua-ac055-'));
    clone = join(scratch, 'repository');
    base = git(STUDY_ROOT, ['rev-parse', 'HEAD']);
    git(scratch, [
      'clone',
      '--quiet',
      '--shared',
      '--no-checkout',
      git(STUDY_ROOT, ['rev-parse', '--show-toplevel']),
      clone,
    ]);
    git(clone, ['checkout', '--quiet', '--detach', base]);
    baseTree = git(clone, ['rev-parse', `${base}^{tree}`]);
    const source = readFileSync(join(clone, VERDICT_SOURCE), 'utf8');
    assert.ok(source.includes(VERDICT_FAILS), 'the seeded regression must find the BR-RUA-006 fail branch');
    writeFileSync(join(clone, VERDICT_SOURCE), source.replace(VERDICT_FAILS, VERDICT_REGRESSED));
    git(clone, ['commit', '--quiet', '--all', '-m', 'test: seed a BR-RUA-006 verdict regression']);
    regressed = git(clone, ['rev-parse', 'HEAD']);
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  async function revisionCheck(args: readonly string[]): Promise<Invocation> {
    const lines: string[] = [];
    const root = createCompositionRoot({
      studyRoot: join(clone, 'study-1'),
      cwd: scratch,
      env: process.env,
      tempRoot: scratch,
      nodeVersion: process.version,
      nodeExecutable: process.execPath,
    });
    const exitCode = await main(
      ['oracle', 'revision-check', ...args],
      { stdout: (line) => lines.push(line), stderr: () => undefined },
      root,
    );
    assert.equal(lines.length, 1, 'exactly one cli_result line on stdout');
    const result = JSON.parse(lines[0] ?? '') as CliResult;
    return { exit_code: exitCode, result, record: result.result_record as unknown as OracleRevisionCheck | undefined };
  }

  it('ac055-revision-check-passes-at-commit', async () => {
    const { exit_code: exitCode, result, record } = await revisionCheck(['--rev', base]);
    assert.equal(exitCode, 0);
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.written_paths, []);
    assert.ok(record !== undefined);
    assert.equal(record.record_type, 'oracle_revision_check');
    assert.equal(record.result, 'passed');
    assert.equal(record.commit_sha, base);
    assert.equal(record.tree_sha, baseTree);
    assert.equal(record.exit_code, 0);
    assert.equal(record.test_counts.fail, 0);
    assert.equal(record.test_counts.skipped, 0);
    assert.equal(record.test_counts.todo, 0);
    assert.equal(record.test_counts.pass, record.test_counts.tests);
    assert.ok(record.test_counts.tests >= record.golden_minimum && record.golden_minimum > 0);
    assert.deepEqual(record.uncovered, []);
    assert.deepEqual(
      [...new Set(record.rule_coverage.map((entry) => entry.rule_id))].toSorted(),
      [...VERDICT_CHANGING_RULES].toSorted(),
    );
    assert.equal(git(clone, ['worktree', 'list']).split('\n').length, 1, 'the temporary worktree is removed');
  });

  it('ac055-revision-check-fails-after-seeded-regression', async () => {
    const { exit_code: exitCode, result, record } = await revisionCheck(['--rev', regressed]);
    assert.equal(exitCode, 5);
    assert.equal(result.outcome, 'verification_failed');
    assert.ok(record !== undefined);
    assert.equal(record.result, 'failed');
    assert.equal(record.commit_sha, regressed);
    assert.notEqual(record.exit_code, 0);
    assert.ok(record.test_counts.fail > 0);
    assert.equal(result.reasons[0]?.code, 'ORACLE_NOT_FINAL');
    assert.equal(result.reasons[0].subject, 'BR-RUA-055');
    assert.equal(git(clone, ['status', '--porcelain']), '', 'the operator work tree is untouched');
  });

  it('ac055-revision-check-at-manifest-revision', async () => {
    const evidence = join(scratch, 'evidence');
    const run = offlineExecution('run');
    const frozen = JSON.parse(
      new TextDecoder().decode(run.core_files.get(EXECUTION_PATHS.executionManifest)),
    ) as ExecutionManifest;
    const manifest = { ...frozen, source: { ...frozen.source, commit_sha: base, tree_sha: baseTree } };
    assert.equal(
      createRecordValidator().validateAs('execution_manifest', manifest as unknown as JsonObject).valid,
      true,
    );
    const manifestPath = join(evidence, run.package_directory, EXECUTION_PATHS.executionManifest);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, serializeRecordFile(manifest));
    const { exit_code: exitCode, record } = await revisionCheck([
      '--package',
      join(evidence, run.package_directory),
      '--evidence-root',
      evidence,
    ]);
    assert.equal(exitCode, 0);
    assert.equal(record?.result, 'passed');
    assert.equal(record.commit_sha, base);
  });
});
