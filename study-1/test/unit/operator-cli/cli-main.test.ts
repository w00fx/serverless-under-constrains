// `main` (design §11): one canonical-JSON `cli_result` line per invocation, the exit code of the
// outcome (0, 2, 3, 4, 5, 6, 7, 10), usage lines on stderr after a usage error, a thrown command
// reported as internal_failure, and a result that breaks the cli_result schema replaced by one.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNNAMED_COMMAND } from '../../../src/operator-cli/cli-main.ts';
import { exitCodeOf, failedOutcome, internalReason, toCliResult } from '../../../src/operator-cli/cli-result.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue, UtcMillis, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { CLI_OUTCOMES } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { HARNESS_NOW, runCli } from './support/cli-harness.ts';
import { RecordingCliCommand } from './support/recording-cli-command.ts';

const RUN_ID = '0b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b' as Uuid4;
const REASON = {
  code: 'PACKAGE_INELIGIBLE',
  subject: 'BR-RUA-044',
  detail: 'altered byte; expected the indexed digest',
};

function verifyCommand(): RecordingCliCommand {
  return new RecordingCliCommand(['run', 'verify'], ['package'], { head: 'optional' });
}

describe('exitCodeOf', () => {
  it('gives every outcome the design §11 code', () => {
    assert.deepEqual(
      CLI_OUTCOMES.map((outcome) => [outcome, exitCodeOf(outcome)]),
      [
        ['completed', 0],
        ['usage_error', 2],
        ['admission_rejected', 3],
        ['execution_incomplete', 4],
        ['verification_failed', 5],
        ['operational_closure_not_clean', 6],
        ['lease_problem', 7],
        ['internal_failure', 10],
      ],
    );
  });
});

describe('toCliResult', () => {
  it('carries the execution field, the unique written paths and the record', () => {
    const result = toCliResult(
      {
        outcome: 'completed',
        execution: { execution_kind: 'RUN', run_id: RUN_ID },
        written_paths: ['a/b.json', 'a/b.json', 'c.json'],
        result_record: { schema_version: 1, record_type: 'oracle_result' },
        reasons: [],
      },
      'run verify',
      HARNESS_NOW as UtcMillis,
    );
    assert.deepEqual(result, {
      schema_version: 1,
      record_type: 'cli_result',
      command: 'run verify',
      outcome: 'completed',
      exit_code: 0,
      run_id: RUN_ID,
      written_paths: ['a/b.json', 'c.json'],
      result_record: { schema_version: 1, record_type: 'oracle_result' },
      reasons: [],
      completed_at: HARNESS_NOW,
    });
  });

  it('omits the execution and record when there are none', () => {
    const result = toCliResult(failedOutcome('lease_problem', [REASON]), 'recover', HARNESS_NOW as UtcMillis);
    assert.equal('run_id' in result, false);
    assert.equal('result_record' in result, false);
    assert.equal(result.exit_code, 7);
    assert.deepEqual(result.reasons, [REASON]);
  });
});

describe('internalReason', () => {
  it('names the thrown error and the expected behavior', () => {
    assert.deepEqual(internalReason(new TypeError('boom')), {
      code: 'INTERNAL_FAILURE',
      subject: 'operator-cli',
      detail: 'TypeError: boom; expected the command to report its outcome as a value',
    });
    assert.equal(internalReason(42).detail, 'a thrown number; expected the command to report its outcome as a value');
    assert.ok(internalReason(new Error('x'.repeat(2_000))).detail.length < 600);
  });
});

describe('main', () => {
  it('runs the named command with the resolved evidence root and prints its result', async () => {
    const command = verifyCommand();
    command.answer({
      outcome: 'completed',
      execution: { execution_kind: 'RUN', run_id: RUN_ID },
      written_paths: ['x.json'],
      reasons: [],
    });
    const run = await runCli(['run', 'verify', 'pkg', '--evidence-root', 'ev'], [command]);
    assert.equal(run.exit_code, 0);
    assert.equal(run.result.command, 'run verify');
    assert.equal(run.result.run_id, RUN_ID);
    assert.equal(run.result.completed_at, HARNESS_NOW);
    assert.equal(run.stdout_lines[0], canonicalJson(run.result as unknown as JsonValue));
    assert.deepEqual(run.stderr_lines, []);
    const [recorded] = command.runs;
    assert.equal(recorded?.context.evidence_root, '/operator/ev');
    assert.equal(recorded.context.resolvePath('pkg'), '/operator/pkg');
    assert.equal(recorded.args.positionals.get('package'), 'pkg');
  });

  it('returns the exit code of every outcome', async () => {
    for (const outcome of CLI_OUTCOMES) {
      const command = verifyCommand();
      command.answer(
        outcome === 'completed' ? { outcome, written_paths: [], reasons: [] } : failedOutcome(outcome, [REASON]),
      );
      const run = await runCli(['run', 'verify', 'pkg'], [command]);
      assert.equal(run.exit_code, exitCodeOf(outcome), outcome);
      assert.equal(run.result.outcome, outcome);
    }
  });

  it('reports a usage error with exit 2, the usage lines on stderr and no command run', async () => {
    const command = verifyCommand();
    const run = await runCli(['run', 'verify'], [command]);
    assert.equal(run.exit_code, 2);
    assert.equal(run.result.outcome, 'usage_error');
    assert.equal(run.result.command, 'run verify');
    assert.equal(run.result.reasons[0]?.code, 'USAGE_ERROR');
    assert.deepEqual(run.stderr_lines, ['rua run verify <package> [--evidence-root <dir>]']);
    assert.equal(command.runs.length, 0);
  });

  it('names an unknown command rua', async () => {
    const run = await runCli(['launch'], [verifyCommand()]);
    assert.equal(run.result.command, UNNAMED_COMMAND);
    assert.equal(UNNAMED_COMMAND, 'rua');
    assert.equal(run.exit_code, 2);
  });

  it('reports a thrown command as internal_failure with exit 10', async () => {
    const command = verifyCommand();
    command.throwOnRun(new RangeError('stack'));
    const run = await runCli(['run', 'verify', 'pkg'], [command]);
    assert.equal(run.exit_code, 10);
    assert.equal(run.result.outcome, 'internal_failure');
    assert.deepEqual(run.result.reasons, [internalReason(new RangeError('stack'))]);
  });

  it('replaces a result that breaks the cli_result schema by an internal failure', async () => {
    const command = verifyCommand();
    command.answer({ outcome: 'completed', written_paths: ['/absolute/path.json'], reasons: [] });
    const run = await runCli(['run', 'verify', 'pkg'], [command]);
    assert.equal(run.exit_code, 10);
    assert.equal(run.result.outcome, 'internal_failure');
    assert.deepEqual(run.result.written_paths, []);
    assert.equal(run.result.reasons[0]?.code, 'CLI_RESULT_INVALID');
    assert.match(
      run.result.reasons[0].detail,
      /^the "run verify" result breaks the cli_result schema at \/written_paths\/0 format; expected a valid cli_result$/,
    );
  });

  it('replaces a failed outcome without reasons by an internal failure', async () => {
    const command = verifyCommand();
    command.answer({ outcome: 'verification_failed', written_paths: [], reasons: [] });
    const run = await runCli(['run', 'verify', 'pkg'], [command]);
    assert.equal(run.exit_code, 10);
    assert.equal(run.result.reasons[0]?.code, 'CLI_RESULT_INVALID');
  });
});
