// The generator's command line as `npm run test:golden` runs it: a real `node` process over a
// study tree in a temporary directory. Its exit status is the result — 0 when the fixtures are
// written or reproduce, 1 on any discrepancy, 2 on a usage error — and `--root` selects the tree.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { STUDY_ROOT } from './golden-harness.ts';

const run = promisify(execFile);
const CLI = join(STUDY_ROOT, 'tools/golden/generate-fixtures.ts');
const root = mkdtempSync(join(tmpdir(), 'rua-golden-cli-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

interface CliOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(args: readonly string[]): Promise<CliOutcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args, '--root', root]);
    return { code: 0, stdout, stderr };
  } catch (error: unknown) {
    const failed = error as { readonly code: number; readonly stdout: string; readonly stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

const CASE = { case_id: 'cli-a', ac_ids: [], rule_outcomes_reached: [], base: 'probe', operations: [], expected: null };

describe('generate-fixtures command line', () => {
  it('writes a missing fixture, checks it, and fails the check once a byte changes', async () => {
    mkdirSync(join(root, 'test/golden/cli/cases'), { recursive: true });
    writeFileSync(join(root, 'test/golden/cli/cases/cli-a.case.ts'), `export default ${JSON.stringify(CASE)};\n`);
    const written = await cli([]);
    assert.deepEqual(written, {
      code: 0,
      stdout: 'cli-a: written\ngolden fixtures (write): 1 case(s), 0 problem(s)\n',
      stderr: '',
    });
    assert.deepEqual(await cli(['--check']), {
      code: 0,
      stdout: 'golden fixtures (check): 1 case(s), 0 problem(s)\n',
      stderr: '',
    });
    writeFileSync(join(root, 'test/golden/cli/fixtures/cli-a/probe/inputs/payment.json'), '{}\n');
    const checked = await cli(['--check']);
    assert.equal(checked.code, 1);
    assert.equal(
      checked.stderr,
      'test/golden/cli/fixtures/cli-a/probe/inputs/payment.json: different; expected the regenerated fixture bytes\n',
    );
  });

  it('defaults the root to the working directory, as npm run test:golden runs it', async () => {
    const { stdout } = await run(process.execPath, [CLI, '--check'], { cwd: STUDY_ROOT });
    assert.match(stdout, /^golden fixtures \(check\): \d+ case\(s\), 0 problem\(s\)\n$/);
  });

  it('exits 2 on a usage error', async () => {
    const outcome = await cli(['--check', '--overwrite', 'cli-a']);
    assert.equal(outcome.code, 2);
    assert.match(outcome.stderr, /^--check with --overwrite cli-a; expected one mode/);
  });
});
