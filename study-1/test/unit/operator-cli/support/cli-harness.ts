// Runs `main` in process over a set of commands and captures what it prints: the one stdout line
// parsed as the `cli_result`, and the stderr lines. The clock is virtual and fixed, the schema
// validator is the production one, and operand paths resolve against `/operator`.

import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { main } from '../../../../src/operator-cli/cli-main.ts';
import type { CliCommand, CompositionRoot } from '../../../../src/operator-cli/cli-types.ts';
import type { CliResult } from '../../../../src/record-contract/records/group-c/cli_result.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

/** The instant every harness result is stamped with. */
export const HARNESS_NOW = '2026-10-06T12:00:00.000Z';
/** The working directory operands resolve against. */
export const HARNESS_CWD = '/operator';

const validator = createRecordValidator();

export interface CliRun {
  readonly exit_code: number;
  readonly result: CliResult;
  readonly stdout_lines: readonly string[];
  readonly stderr_lines: readonly string[];
}

/**
 * The composition root the harness runs `main` with.
 *
 * @example
 * harnessRoot([command]).resolvePath('evidence'); // '/operator/evidence'
 */
export function harnessRoot(commands: readonly CliCommand[]): CompositionRoot {
  return {
    commands,
    clock: new VirtualTimeScheduler({ wallEpochMs: Date.parse(HARNESS_NOW) }),
    validator,
    resolvePath: (path: string): string => resolve(HARNESS_CWD, path),
  };
}

/**
 * Runs one invocation and parses its single result line.
 *
 * @example
 * const run = await runCli(['oracle', 'revision-check'], [command]);
 * run.result.outcome; // 'completed'
 */
export async function runCli(argv: readonly string[], commands: readonly CliCommand[]): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await main(
    argv,
    { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) },
    harnessRoot(commands),
  );
  assert.equal(stdout.length, 1, 'exactly one stdout line');
  return {
    exit_code: exitCode,
    result: JSON.parse(stdout[0] ?? '') as CliResult,
    stdout_lines: stdout,
    stderr_lines: stderr,
  };
}
