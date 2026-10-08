// The local CommandRunner binding against real subprocesses (design §12.2): an exit status with
// both output streams, a run ended by a signal, an executable that cannot start or arguments that
// spawn refuses (a value, never a rejection), exactly the given environment and working directory with nothing inherited, a
// closed stdin, and each stream kept as its last 64 KiB.

import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import {
  ChildProcessCommandRunner,
  OUTPUT_TAIL_LIMIT,
} from '../../../src/deployment-assembly/node/child-process-command-runner.ts';

const runner = new ChildProcessCommandRunner();

function nodeScript(
  script: string,
  env: Readonly<Record<string, string>> = {},
  cwd = tmpdir(),
): ReturnType<ChildProcessCommandRunner['run']> {
  return runner.run({ executable: process.execPath, args: ['-e', script], cwd, env });
}

describe('ChildProcessCommandRunner', () => {
  it('returns the exit status with stdout and stderr', async () => {
    const result = await nodeScript('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)');
    assert.deepEqual(result, { kind: 'exited', exit_code: 3, stdout: 'out', stderr: 'err' });
  });

  it('reports a run ended by a signal', async () => {
    const result = await nodeScript(
      'process.stderr.write("dying"); process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 10000)',
    );
    assert.deepEqual(result, { kind: 'signalled', signal: 'SIGTERM', stdout: '', stderr: 'dying' });
  });

  it('returns spawn_failed for an executable that does not exist', async () => {
    const result = await runner.run({ executable: '/nonexistent/node', args: [], cwd: tmpdir(), env: {} });
    assert.ok(result.kind === 'spawn_failed', JSON.stringify(result));
    assert.match(result.detail, /^\/nonexistent\/node: spawn \/nonexistent\/node ENOENT/);
  });

  // Regression (WP-24 review, 2026-10-06): `spawn` validates its arguments synchronously and throws
  // ERR_INVALID_ARG_VALUE for a NUL byte, which rejected the promise the port says never rejects.
  it('returns spawn_failed, never a rejection, when spawn refuses its arguments synchronously', async () => {
    for (const invocation of [
      { executable: process.execPath, args: ['-e', 'a\u0000b'], cwd: tmpdir(), env: {} },
      { executable: process.execPath, args: [], cwd: tmpdir(), env: { SUC_MARKER: 'a\u0000b' } },
    ]) {
      const result = await runner.run(invocation);
      assert.ok(result.kind === 'spawn_failed', JSON.stringify(result));
      assert.match(result.detail, /^\S+: .*must be a string without null bytes/);
    }
  });

  it('runs with exactly the given environment and working directory, and stdin closed', async () => {
    const cwd = realpathSync(tmpdir());
    const result = await nodeScript(
      'let stdin = ""; process.stdin.on("data", (c) => { stdin += c; }); process.stdin.on("end", () => ' +
        'process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, marker: process.env.SUC_MARKER, cwd: process.cwd(), stdin })))',
      { SUC_MARKER: 'synth' },
      cwd,
    );
    assert.ok(result.kind === 'exited', JSON.stringify(result));
    const seen: unknown = JSON.parse(result.stdout);
    assert.deepEqual(seen, { home: null, marker: 'synth', cwd, stdin: '' });
  });

  it('keeps the last 64 KiB of each stream', async () => {
    const result = await nodeScript(
      `process.stdout.write("a".repeat(${String(OUTPUT_TAIL_LIMIT)}) + "TAIL"); process.stderr.write("b".repeat(${String(OUTPUT_TAIL_LIMIT * 2)}) + "END")`,
    );
    assert.ok(result.kind === 'exited', result.kind);
    const { stdout, stderr } = result;
    assert.deepEqual([stdout.length, stderr.length], [OUTPUT_TAIL_LIMIT, OUTPUT_TAIL_LIMIT]);
    assert.ok(stdout.endsWith('aTAIL') && stderr.endsWith('bEND'));
  });
});
