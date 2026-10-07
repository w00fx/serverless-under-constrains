// `probe|validation|run execute` (design §11, §10.2; AC-RUA-002, AC-RUA-021, AC-RUA-027): before
// the runner is built the command reads the admitted package of its kind, requires the confirmation
// to equal the admitted execution id and refuses a package a runner already started; while the
// runner works the first SIGINT aborts it and every later one is only reported; the result line
// carries the runner outcome's exit code and the package index once it is finalized.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AdmittedExecution, ExecutionOutcome } from '../../../src/execution-lifecycle/execution-ports.ts';
import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import { ExecuteCommand } from '../../../src/operator-cli/execute-commands.ts';
import type { ExecutionSession, ExecutionSessionFactory } from '../../../src/operator-cli/execute-commands.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { ExecutionKind, Result, StructuredReason } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { GoldenExecution } from '../../support/golden-builder/golden-plan.ts';
import type { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { runCli } from './support/cli-harness.ts';
import type { CliRun } from './support/cli-harness.ts';
import { admittedFiles, goldenAdmitted } from './support/golden-admitted.ts';
import { ManualInterruptSource } from './support/manual-interrupt-source.ts';
import { ScriptedExecutionSession } from './support/scripted-execution-session.ts';
import { STORED_EVIDENCE_ROOT, packageOperand, storePackage } from './support/stored-packages.ts';

const validator = createRecordValidator();
const ROOT_FLAG = ['--evidence-root', STORED_EVIDENCE_ROOT];
const CONFIRM = '--confirm-cloud-mutation';
const WORD: Readonly<Record<ExecutionKind, string>> = {
  TRANSPORT_PROBE: 'probe',
  VARIANT_VALIDATION: 'validation',
  RUN: 'run',
};

function cleanOutcome(admitted: AdmittedExecution, overrides: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  const frozen = { kind: 'frozen', interruption: undefined };
  return {
    package_finalized: true,
    trials: admitted.manifest.trials.map(() => frozen) as unknown as ExecutionOutcome['trials'],
    ...(admitted.identity.execution_kind === 'TRANSPORT_PROBE'
      ? { probe: frozen as unknown as NonNullable<ExecutionOutcome['probe']> }
      : {}),
    cleanup_status: 'succeeded',
    leak_audit_status: 'clean',
    lease_status: 'released',
    reasons: [],
    ...overrides,
  };
}

interface ExecuteWorld {
  readonly admitted: AdmittedExecution;
  readonly fs: MemoryPackageFileSystem;
  readonly interrupts: ManualInterruptSource;
  readonly built: AdmittedExecution[];
  readonly command: ExecuteCommand;
}

async function executeWorld(
  name: GoldenExecution,
  session: ScriptedExecutionSession | undefined,
  kind?: ExecutionKind,
): Promise<ExecuteWorld> {
  const admitted = goldenAdmitted(name);
  const fs = await storePackage(admitted.identity, admittedFiles(name));
  const interrupts = new ManualInterruptSource();
  const built: AdmittedExecution[] = [];
  const sessions: ExecutionSessionFactory = (candidate, evidenceRoot) => {
    built.push(candidate);
    assert.equal(evidenceRoot, STORED_EVIDENCE_ROOT);
    return session === undefined
      ? err({ code: 'COORDINATION_TABLE_UNNAMED', subject: 'BR-RUA-045', detail: 'no table' })
      : ok(session);
  };
  const command = new ExecuteCommand(kind ?? admitted.identity.execution_kind, {
    files: (): PackageFileSystem => fs,
    validator,
    sessions,
    interrupts,
  });
  return { admitted, fs, interrupts, built, command };
}

function execute(world: ExecuteWorld, confirmation: string = executionIdOf(world.admitted.identity)): Promise<CliRun> {
  const word = WORD[world.admitted.identity.execution_kind];
  return runCli(
    [word, 'execute', packageOperand(world.admitted.identity), CONFIRM, confirmation, ...ROOT_FLAG],
    [world.command],
  );
}

describe('execute commands', () => {
  it('runs each kind through its own runner method and reports the finalized package', async () => {
    const cases: readonly (readonly [GoldenExecution, string])[] = [
      ['run', 'runCanonical'],
      ['validation-conventional', 'runValidation'],
      ['probe', 'runProbe'],
    ];
    for (const [name, method] of cases) {
      const admitted = goldenAdmitted(name);
      const session = new ScriptedExecutionSession(cleanOutcome(admitted));
      const world = await executeWorld(name, session);
      const run = await execute(world);
      assert.equal(run.exit_code, 0, `${name}: ${JSON.stringify(run.result.reasons)}`);
      assert.deepEqual(session.runs, [method]);
      assert.deepEqual(run.result.written_paths, [`${admitted.package_directory}/package-index.json`]);
      assert.deepEqual(run.stderr_lines, [`executing ${admitted.package_directory}`]);
      assert.equal(world.interrupts.listening(), 0, 'unsubscribed once the execution ended');
    }
  });

  it('names the command words and grammar of each kind', async () => {
    const world = await executeWorld('run', undefined);
    assert.deepEqual(world.command.spec.words, ['run', 'execute']);
    assert.equal(world.command.spec.usage, 'run execute <package> --confirm-cloud-mutation <execution_id>');
    assert.deepEqual([...world.command.spec.flags], [['confirm-cloud-mutation', 'required']]);
  });

  it('maps the runner outcome to its exit code', async () => {
    const admitted = goldenAdmitted('run');
    const cases: readonly (readonly [Partial<ExecutionOutcome>, number])[] = [
      [{ lease_status: 'unverified' }, 7],
      [{ cleanup_status: 'failed' }, 6],
      [{ interruption: { cause: 'OPERATOR_ABORT', detail: 'SIGINT' } }, 4],
      [{ package_finalized: false }, 10],
    ];
    for (const [overrides, code] of cases) {
      const world = await executeWorld('run', new ScriptedExecutionSession(cleanOutcome(admitted, overrides)));
      assert.equal((await execute(world)).exit_code, code, JSON.stringify(overrides));
    }
  });

  it('aborts on the first SIGINT and only reports the later ones', async () => {
    const admitted = goldenAdmitted('run');
    const interrupts = new ManualInterruptSource();
    const session = new ScriptedExecutionSession(
      cleanOutcome(admitted, { interruption: { cause: 'OPERATOR_ABORT', detail: 'SIGINT' } }),
      () => {
        interrupts.fire();
        interrupts.fire();
      },
    );
    const world = { ...(await executeWorld('run', session)) };
    const command = new ExecuteCommand('RUN', {
      files: (): PackageFileSystem => world.fs,
      validator,
      sessions: (): Result<ExecutionSession, StructuredReason> => ok(session),
      interrupts,
    });
    const run = await execute({ ...world, command });
    assert.equal(run.exit_code, 4);
    assert.deepEqual(session.aborts, ['SIGINT', 'SIGINT']);
    assert.deepEqual(run.stderr_lines, [
      `executing ${admitted.package_directory}`,
      'SIGINT: interrupting the execution (OPERATOR_ABORT); cleanup still runs to its end',
      'SIGINT again: the execution is already interrupted; cleanup still runs to its end',
    ]);
    assert.equal(interrupts.listening(), 0);
  });

  it('refuses a confirmation that is not the admitted execution id before building the runner', async () => {
    const world = await executeWorld('run', new ScriptedExecutionSession(cleanOutcome(goldenAdmitted('run'))));
    const run = await execute(world, 'b42ee7a8');
    assert.equal(run.exit_code, 2);
    assert.deepEqual(world.built, []);
    assert.match(
      run.result.reasons[0]?.detail ?? '',
      /^--confirm-cloud-mutation "b42ee7a8" does not confirm "b42ee7a8-/,
    );
  });

  it('refuses a package of another kind as a usage error', async () => {
    const world = await executeWorld(
      'probe',
      new ScriptedExecutionSession(cleanOutcome(goldenAdmitted('probe'))),
      'RUN',
    );
    const run = await runCli(
      [
        'run',
        'execute',
        packageOperand(world.admitted.identity),
        CONFIRM,
        executionIdOf(world.admitted.identity),
        ...ROOT_FLAG,
      ],
      [world.command],
    );
    assert.equal(run.exit_code, 2);
    assert.deepEqual(world.built, []);
  });

  it('refuses a package whose frozen manifest does not read back', async () => {
    const admitted = goldenAdmitted('run');
    const fs = await storePackage(
      admitted.identity,
      admittedFiles('run').filter((file) => file.path !== EXECUTION_PATHS.executionManifest),
    );
    const world = { ...(await executeWorld('run', undefined)), fs };
    const command = new ExecuteCommand('RUN', {
      files: (): PackageFileSystem => fs,
      validator,
      sessions: (): never => assert.fail('never built'),
      interrupts: new ManualInterruptSource(),
    });
    const run = await execute({ ...world, command });
    assert.equal(run.exit_code, 5);
    assert.equal(run.result.outcome, 'verification_failed');
  });

  it('refuses a package a runner already started, or whose runner journal cannot be checked', async () => {
    const admitted = goldenAdmitted('run');
    const journal = `${admitted.package_directory}/${EXECUTION_PATHS.runnerJournal}`;
    const started = await executeWorld('run', new ScriptedExecutionSession(cleanOutcome(admitted)));
    await started.fs.writeOnce(journal, new TextEncoder().encode('{}\n'));
    const run = await execute(started);
    assert.equal(run.exit_code, 5);
    assert.deepEqual(started.built, []);
    assert.deepEqual(run.result.reasons, [
      {
        code: 'PACKAGE_ALREADY_EXECUTED',
        subject: 'BR-RUA-040',
        artifact_path: EXECUTION_PATHS.runnerJournal,
        detail: `${journal} exists; expected an admitted package that no runner has started`,
      },
    ]);
    const unreadable = await executeWorld('run', new ScriptedExecutionSession(cleanOutcome(admitted)));
    unreadable.fs.failReads(journal, 'IO_ERROR');
    const refused = await execute(unreadable);
    assert.equal(refused.exit_code, 5);
    assert.match(
      refused.result.reasons[0]?.detail ?? '',
      / cannot be checked \(IO_ERROR: .*\); expected an admitted package/,
    );
  });

  it('refuses a package whose runner cannot be built, naming the execution', async () => {
    const world = await executeWorld('run', undefined);
    const run = await execute(world);
    assert.equal(run.exit_code, 5);
    assert.equal(
      run.result.run_id,
      world.admitted.identity.execution_kind === 'RUN' ? world.admitted.identity.run_id : '',
    );
    assert.deepEqual(run.result.reasons, [
      { code: 'COORDINATION_TABLE_UNNAMED', subject: 'BR-RUA-045', detail: 'no table' },
    ]);
    assert.equal(world.interrupts.listening(), 0);
  });
});
