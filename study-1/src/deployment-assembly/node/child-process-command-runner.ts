// Local binding of the CommandRunner port: `child_process.spawn` with no shell, the invocation's
// working directory and exactly its environment (nothing is inherited implicitly). stdin is closed,
// so a CLI that would prompt fails instead of waiting. Output streams are kept as their last
// 64 KiB, which bounds memory for a chatty CLI while keeping the error at the end of stderr.
// Node facts (https://nodejs.org/docs/latest-v24.x/api/child_process.html): a process that cannot
// start emits `error` (and may never emit `close`); a started one emits `close` with an exit code
// or the signal that ended it. `spawn` itself throws for arguments it refuses, such as a NUL byte
// in an argument or an environment value; that throw is a `spawn_failed` value too (WP-24 review,
// 2026-10-06), so the promise never rejects.

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import type { CommandInvocation, CommandResult, CommandRunner } from '../command-runner.ts';

/** How many trailing characters of each output stream a result keeps. */
export const OUTPUT_TAIL_LIMIT = 64 * 1024;

/**
 * Runs subprocesses on the local machine.
 *
 * @example
 * const result = await new ChildProcessCommandRunner().run({ executable: process.execPath, args: ['-v'], cwd, env: {} });
 */
export class ChildProcessCommandRunner implements CommandRunner {
  /**
   * Runs one invocation to completion; never rejects.
   *
   * @example
   * await runner.run(cdkSynthInvocation(settings, stagingDir, stackName));
   */
  run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = startChild(invocation);
      if (child instanceof Error) {
        resolve(spawnFailed(invocation, child));
        return;
      }
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout = tail(stdout + chunk);
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr = tail(stderr + chunk);
      });
      child.once('error', (error: Error) => {
        resolve(spawnFailed(invocation, error));
      });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
        resolve(
          code === null
            ? { kind: 'signalled', signal: signal ?? 'unknown', stdout, stderr }
            : { kind: 'exited', exit_code: code, stdout, stderr },
        );
      });
    });
  }
}

type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

// The started child, or the error `spawn` threw while validating the invocation.
function startChild(invocation: CommandInvocation): PipedChild | Error {
  try {
    return spawn(invocation.executable, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...invocation.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (thrown: unknown) {
    return thrown instanceof Error ? thrown : new Error(String(thrown));
  }
}

function spawnFailed(invocation: CommandInvocation, error: Error): CommandResult {
  return { kind: 'spawn_failed', detail: `${invocation.executable}: ${error.message}` };
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_LIMIT ? text.slice(-OUTPUT_TAIL_LIMIT) : text;
}
