// `rua oracle revision-check` over the scripted workspace (BR-RUA-055): which revision it checks
// (`--rev`, `HEAD`, or the one a package's manifest recorded), how each workspace failure maps to
// an outcome, that the checkout is released exactly once whatever happens, and that the printed
// record is admission's `oracleRevisionCheck` verdict.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import type { GoldenSuiteRun } from '../../../src/admission/admission-ports.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { parseArgs } from '../../../src/operator-cli/arg-parsing.ts';
import type { CliOutcomeReport, CommandContext } from '../../../src/operator-cli/cli-types.ts';
import {
  DEFAULT_REVISION,
  OracleRevisionCheckCommand,
  revisionReason,
} from '../../../src/operator-cli/oracle-revision-check.ts';
import { boundedJsonText } from '../../../src/record-contract/json-value.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import type { ExecutionManifest } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import type { OracleRevisionCheck } from '../../../src/record-contract/records/group-c/oracle_revision_check.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { FakeGoldenSuiteRunner } from '../../support/admission/fake-golden-suite-runner.ts';
import { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { ScriptedRevisionWorkspace } from '../../integration/operator-cli/fakes/scripted-revision-workspace.ts';
import { HARNESS_CWD, HARNESS_NOW } from './support/cli-harness.ts';

const COMMIT = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const HEAD_COMMIT = 'c'.repeat(40);
const EVIDENCE_ROOT = resolve(HARNESS_CWD, 'evidence');
const validator = createRecordValidator();
const run = offlineExecution('run');
const FAILURE = revisionReason('SCRIPTED', 'scripted failure; expected none');

async function goldenRun(failing: number): Promise<GoldenSuiteRun> {
  const golden = new FakeGoldenSuiteRunner();
  golden.failTests(failing);
  const read = await golden.readGoldenSuiteRun();
  assert.equal(read.ok, true);
  return read.value;
}

interface Setup {
  readonly workspace: ScriptedRevisionWorkspace;
  readonly files: MemoryPackageFileSystem;
  readonly roots: string[];
  readonly command: OracleRevisionCheckCommand;
}

async function setup(failingTests = 0): Promise<Setup> {
  const workspace = new ScriptedRevisionWorkspace(
    new Map([
      [COMMIT, { commit_sha: COMMIT, tree_sha: TREE }],
      [DEFAULT_REVISION, { commit_sha: HEAD_COMMIT, tree_sha: TREE }],
    ]),
    await goldenRun(failingTests),
  );
  const files = new MemoryPackageFileSystem();
  const roots: string[] = [];
  const command = new OracleRevisionCheckCommand({
    workspace,
    files: (root): MemoryPackageFileSystem => {
      roots.push(root);
      return files;
    },
    validator,
    clock: new VirtualTimeScheduler({ wallEpochMs: Date.parse(HARNESS_NOW) }),
    node_version: 'v24.15.0',
  });
  return { workspace, files, roots, command };
}

async function invoke(
  command: OracleRevisionCheckCommand,
  flags: readonly string[],
): Promise<{
  readonly report: CliOutcomeReport;
  readonly progress: readonly string[];
}> {
  const parsed = parseArgs(['oracle', 'revision-check', ...flags], [command]);
  assert.equal(parsed.ok, true);
  const progress: string[] = [];
  const context: CommandContext = {
    evidence_root: EVIDENCE_ROOT,
    resolvePath: (path) => resolve(HARNESS_CWD, path),
    progress: (line) => progress.push(line),
  };
  return { report: await command.run(parsed.value, context), progress };
}

async function writeManifest(
  files: MemoryPackageFileSystem,
  source: { commit_sha: string; tree_sha: string },
): Promise<string> {
  const frozen = JSON.parse(
    new TextDecoder().decode(run.core_files.get(EXECUTION_PATHS.executionManifest)),
  ) as ExecutionManifest;
  const manifest = { ...frozen, source: { ...frozen.source, ...source } };
  const written = await files.writeOnce(
    `${run.package_directory}/${EXECUTION_PATHS.executionManifest}`,
    serializeRecordFile(manifest),
  );
  assert.equal(written.ok, true);
  return `evidence/${run.package_directory}`;
}

function recordOf(report: CliOutcomeReport): OracleRevisionCheck {
  assert.ok(report.result_record !== undefined);
  return report.result_record as unknown as OracleRevisionCheck;
}

describe('OracleRevisionCheckCommand', () => {
  it('passes at a revision whose golden suite is final, and releases the worktree', async () => {
    const { workspace, command } = await setup();
    const { report, progress } = await invoke(command, ['--rev', COMMIT]);
    assert.equal(report.outcome, 'completed');
    assert.deepEqual(report.written_paths, []);
    assert.deepEqual(report.reasons, []);
    const record = recordOf(report);
    assert.equal(record.result, 'passed');
    assert.equal(record.commit_sha, COMMIT);
    assert.equal(record.tree_sha, TREE);
    assert.equal(record.node_version, 'v24.15.0');
    assert.equal(record.checked_at, HARNESS_NOW);
    assert.equal(validator.validateAs('oracle_revision_check', report.result_record ?? {}).valid, true);
    assert.deepEqual(workspace.calls, [
      `checkout ${COMMIT}`,
      `install ${COMMIT}`,
      `golden ${COMMIT}`,
      `release ${COMMIT}`,
    ]);
    assert.equal(workspace.openCheckouts(), 0);
    assert.deepEqual(progress, [`checking the oracle at ${COMMIT} in /scripted/${COMMIT}/study-1/`]);
  });

  it('checks HEAD when no flag is given', async () => {
    const { workspace, command } = await setup();
    const { report } = await invoke(command, []);
    assert.equal(recordOf(report).commit_sha, HEAD_COMMIT);
    assert.equal(workspace.calls[0], 'checkout HEAD');
  });

  it('fails when a golden test fails, with the attestation reasons', async () => {
    const { workspace, command } = await setup(1);
    const { report } = await invoke(command, ['--rev', COMMIT]);
    assert.equal(report.outcome, 'verification_failed');
    const record = recordOf(report);
    assert.equal(record.result, 'failed');
    assert.deepEqual(report.reasons, record.reasons);
    assert.equal(report.reasons[0].code, 'ORACLE_NOT_FINAL');
    assert.equal(workspace.openCheckouts(), 0);
  });

  it('refuses --rev with --package as a usage error before any checkout', async () => {
    const { workspace, command } = await setup();
    const { report } = await invoke(command, ['--rev', COMMIT, '--package', 'evidence/runs/x']);
    assert.equal(report.outcome, 'usage_error');
    assert.equal(
      report.reasons[0]?.detail,
      '--rev and --package were both given; expected oracle revision-check [--rev <commit> | --package <package>]',
    );
    assert.deepEqual(workspace.calls, []);
  });

  it('refuses a revision that is not a revision name', async () => {
    for (const revision of ['-x', '.hidden', 'a b', `a${'b'.repeat(256)}`, 'a\nb']) {
      const { workspace, command } = await setup();
      const { report } = await invoke(command, ['--rev', revision]);
      assert.equal(report.outcome, 'usage_error', revision);
      assert.equal(
        report.reasons[0]?.detail,
        `revision ${boundedJsonText(revision)} is not a git revision name; expected a commit, branch or tag name that starts with a letter or digit and holds no whitespace`,
      );
      assert.deepEqual(workspace.calls, []);
    }
  });

  it('fails when the revision cannot be checked out, with nothing to release', async () => {
    const { workspace, command } = await setup();
    const { report } = await invoke(command, ['--rev', 'd'.repeat(40)]);
    assert.equal(report.outcome, 'verification_failed');
    assert.equal(report.reasons[0]?.code, 'REVISION_UNRESOLVED');
    assert.deepEqual(workspace.calls, [`checkout ${'d'.repeat(40)}`]);
  });

  it('fails when the dependencies cannot be installed, and still releases', async () => {
    const { workspace, command } = await setup();
    workspace.fail('install', FAILURE);
    const { report } = await invoke(command, ['--rev', COMMIT]);
    assert.deepEqual(report, { outcome: 'verification_failed', written_paths: [], reasons: [FAILURE] });
    assert.deepEqual(workspace.calls, [`checkout ${COMMIT}`, `install ${COMMIT}`, `release ${COMMIT}`]);
  });

  it('fails when the golden suite cannot be read, and still releases', async () => {
    const { workspace, command } = await setup();
    workspace.fail('golden', FAILURE);
    const { report } = await invoke(command, ['--rev', COMMIT]);
    assert.deepEqual(report, { outcome: 'verification_failed', written_paths: [], reasons: [FAILURE] });
    assert.equal(workspace.openCheckouts(), 0);
  });

  it('appends a release failure to an otherwise passing report', async () => {
    const { workspace, command } = await setup();
    workspace.fail('release', FAILURE);
    const { report } = await invoke(command, ['--rev', COMMIT]);
    assert.equal(report.outcome, 'completed');
    assert.equal(recordOf(report).result, 'passed');
    assert.deepEqual(report.reasons, [FAILURE]);
  });

  it('checks the revision and tree a package manifest recorded', async () => {
    const { workspace, files, roots, command } = await setup();
    const packagePath = await writeManifest(files, { commit_sha: COMMIT, tree_sha: TREE });
    const { report } = await invoke(command, ['--package', packagePath]);
    assert.equal(report.outcome, 'completed');
    assert.equal(recordOf(report).commit_sha, COMMIT);
    assert.deepEqual(roots, [EVIDENCE_ROOT]);
    assert.equal(workspace.calls[0], `checkout ${COMMIT}`);
  });

  it('fails when the checked-out tree is not the tree the manifest recorded', async () => {
    const { workspace, files, command } = await setup();
    const recorded = 'e'.repeat(40);
    const packagePath = await writeManifest(files, { commit_sha: COMMIT, tree_sha: recorded });
    const { report } = await invoke(command, ['--package', packagePath]);
    assert.deepEqual(report, {
      outcome: 'verification_failed',
      written_paths: [],
      reasons: [
        revisionReason(
          'REVISION_TREE_MISMATCH',
          `commit ${COMMIT} has tree ${TREE}, but the manifest recorded tree "${recorded}"; expected the recorded tree`,
        ),
      ],
    });
    assert.deepEqual(workspace.calls, [`checkout ${COMMIT}`, `release ${COMMIT}`]);
  });

  it('refuses a package operand that is not a package directory', async () => {
    const { workspace, command } = await setup();
    const { report } = await invoke(command, ['--package', 'evidence/trials/x']);
    assert.equal(report.outcome, 'usage_error');
    assert.match(report.reasons[0]?.detail ?? '', /is not a package directory/);
    assert.deepEqual(workspace.calls, []);
  });

  it('fails when the package has no readable manifest', async () => {
    const { workspace, command } = await setup();
    const { report } = await invoke(command, ['--package', `evidence/${run.package_directory}`]);
    assert.equal(report.outcome, 'verification_failed');
    assert.equal(report.reasons[0]?.code, 'EXECUTION_MANIFEST_UNREADABLE');
    assert.deepEqual(workspace.calls, []);
  });
});
