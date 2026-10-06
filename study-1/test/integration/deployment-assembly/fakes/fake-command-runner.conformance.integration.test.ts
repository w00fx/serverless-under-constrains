// Conformance of FakeCommandRunner to the pinned CDK CLI 2.1144.0 (design §12.2; RF V1, RK-13).
// What the deployment assembly relies on is that a CLI given `--app <cloud assembly directory>`
// writes a read lock into that directory, which is why the deploy copy is never the package copy.
// Sources, in `node_modules/aws-cdk/lib/index.js` of 2.1144.0:
// - L309889: when `--app` is a directory, `new RWLock(app).acquireRead()` (every command that
//   reads an app goes through this function, `ls` as well as `deploy`);
// - L113250: the reader file is `read.${pid}.${++readCounter}.lock`, written atomically with the
//   pid as its content (L113153) and deleted on release, with no exit handler.
// The real CLI is run here without credentials (`cdk ls` reads no account) against a minimal cloud
// assembly while the directory is watched, and the fake is held to the same file effects.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Manifest } from 'aws-cdk-lib/cloud-assembly-schema';

import { cdkDeployInvocation, cdkSynthInvocation } from '../../../../src/deployment-assembly/cdk-invocations.ts';
import type { CdkToolSettings } from '../../../../src/deployment-assembly/cdk-invocations.ts';
import type { CommandResult } from '../../../../src/deployment-assembly/command-runner.ts';
import { DiskCommandEffects } from '../../../support/deployment-assembly/disk-command-effects.ts';
import { FAKE_FIRST_PID, FakeCommandRunner } from '../../../support/deployment-assembly/fake-command-runner.ts';
import { MemoryAssemblyFileSystem } from '../../../support/deployment-assembly/memory-assembly-file-system.ts';

const STUDY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const CLI_ENTRY = join(STUDY_ROOT, 'node_modules/aws-cdk/bin/cdk');
const CLI_BUNDLE = join(STUDY_ROOT, 'node_modules/aws-cdk/lib/index.js');
const directories: string[] = [];
const decoder = new TextDecoder();
const SIGNALLED: CommandResult = { kind: 'signalled', signal: 'SIGKILL', stdout: '', stderr: '' };
const FAILED: CommandResult = { kind: 'exited', exit_code: 1, stdout: '', stderr: 'boom' };

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rua-fake-cli-'));
  directories.push(root);
  return root;
}

function tools(root: string): CdkToolSettings {
  return {
    node_executable: process.execPath,
    cdk_cli_entry: CLI_ENTRY,
    study_root: STUDY_ROOT,
    docker_sentinel: join(STUDY_ROOT, 'tools/docker-forbidden.sh'),
    environment: { HOME: root },
  };
}

interface ObservedCli {
  readonly pid: number;
  readonly names: readonly string[];
}

// Runs the real CLI on an assembly directory and reports every name that appeared in it.
function observeRealCli(appDir: string): Promise<ObservedCli> {
  const names: string[] = [];
  const watcher = watch(appDir, (_event, name) => {
    if (name !== null) {
      names.push(name);
    }
  });
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'ls', '--app', appDir, '--no-version-reporting', '--no-notices'],
      {
        cwd: STUDY_ROOT,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: appDir,
          CDK_DISABLE_CLI_TELEMETRY: 'true',
          AWS_EC2_METADATA_DISABLED: 'true',
          AWS_CONFIG_FILE: join(appDir, 'absent'),
          AWS_SHARED_CREDENTIALS_FILE: join(appDir, 'absent'),
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      },
    );
    child.once('close', () => {
      setTimeout(() => {
        watcher.close();
        resolve({ pid: child.pid ?? -1, names });
      }, 200);
    });
  });
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('FakeCommandRunner conforms to the pinned CDK CLI', () => {
  it('pins CLI 2.1144.0, whose source takes a read lock named read.<pid>.<n>.lock on an --app directory', () => {
    const version: unknown = JSON.parse(readFileSync(join(STUDY_ROOT, 'node_modules/aws-cdk/package.json'), 'utf8'));
    assert.equal((version as { readonly version: string }).version, '2.1144.0');
    const lines = readFileSync(CLI_BUNDLE, 'utf8').split('\n');
    assert.match(lines[309888] ?? '', /const lock = await new RWLock\(app\)\.acquireRead\(\);/);
    assert.match(lines[113249] ?? '', /`read\.\$\{this\.pidString\}\.\$\{\+\+readCounter\}\.lock`/);
    assert.match(lines[113152] ?? '', /async function writeLockFile\(filename, contents\)/);
  });

  it('the real CLI writes read.<pid>.1.lock into the --app directory and removes it when it exits', async () => {
    const appDir = temporaryRoot();
    writeFileSync(join(appDir, 'manifest.json'), JSON.stringify({ version: Manifest.version() }));
    const observed = await observeRealCli(appDir);
    assert.ok(
      observed.names.includes(`read.${String(observed.pid)}.1.lock`),
      `saw ${JSON.stringify(observed.names)}; expected read.${String(observed.pid)}.1.lock`,
    );
    assert.deepEqual(readdirSync(appDir), ['manifest.json']);
  });

  it('the fake writes the same lock with the pid as content, and removes it unless a signal ends the run', async () => {
    const appDir = temporaryRoot();
    const runner = new FakeCommandRunner(new DiskCommandEffects());
    runner.enqueue(FAILED);
    runner.enqueue(SIGNALLED);
    const outputs = join(temporaryRoot(), 'outputs.json');
    for (let run = 0; run < 3; run += 1) {
      await runner.run(cdkDeployInvocation(tools(appDir), appDir, 'SucRua-run-3f1c2a9e', outputs));
    }
    const pids = [FAKE_FIRST_PID, FAKE_FIRST_PID + 1, FAKE_FIRST_PID + 2];
    assert.deepEqual(
      runner.locksWritten(),
      pids.map((pid) => join(appDir, `read.${String(pid)}.1.lock`)),
    );
    const left = `read.${String(FAKE_FIRST_PID + 1)}.1.lock`;
    assert.deepEqual(readdirSync(appDir), [left]);
    assert.equal(readFileSync(join(appDir, left), 'utf8'), String(FAKE_FIRST_PID + 1));
  });
});

describe('FakeCommandRunner scripting', () => {
  it('records invocations and answers queued results in order, then exit status 0', async () => {
    const files = new MemoryAssemblyFileSystem();
    const runner = new FakeCommandRunner(files);
    runner.enqueue(FAILED);
    const invocation = cdkSynthInvocation(tools('/w'), '/w/staging', 'SucRua-run-3f1c2a9e');
    assert.ok(invocation.ok);
    const first = await runner.run(invocation.value);
    const second = await runner.run(invocation.value);
    assert.deepEqual([first, second], [FAILED, { kind: 'exited', exit_code: 0, stdout: '', stderr: '' }]);
    assert.deepEqual(runner.invocations(), [invocation.value, invocation.value]);
  });

  it('materializes the scripted assembly only for a synthesis that exits 0', async () => {
    const files = new MemoryAssemblyFileSystem();
    const runner = new FakeCommandRunner(files);
    runner.scriptSynthOutput([{ path: 'manifest.json', bytes: Uint8Array.of(0x7b, 0x7d), mode: 0o644 }]);
    runner.enqueue(FAILED);
    const invocation = cdkSynthInvocation(tools('/w'), '/w/staging', 'SucRua-run-3f1c2a9e');
    assert.ok(invocation.ok);
    await runner.run(invocation.value);
    assert.equal((await files.list('/w/staging/cdk.out')).ok, false);
    await runner.run(invocation.value);
    assert.deepEqual(await files.read('/w/staging/cdk.out/manifest.json'), {
      ok: true,
      value: Uint8Array.of(0x7b, 0x7d),
    });
  });

  it('writes the scripted outputs file only for a deployment that exits 0', async () => {
    const files = new MemoryAssemblyFileSystem();
    const runner = new FakeCommandRunner(files);
    const invocation = cdkDeployInvocation(tools('/w'), '/w/copy', 'SucRua-run-3f1c2a9e', '/w/outputs.json');
    await runner.run(invocation);
    assert.equal((await files.read('/w/outputs.json')).ok, false);
    runner.scriptDeployOutputs('{"SucRua-run-3f1c2a9e":{}}');
    runner.enqueue(FAILED);
    await runner.run(invocation);
    assert.equal((await files.read('/w/outputs.json')).ok, false);
    await runner.run(invocation);
    const written = await files.read('/w/outputs.json');
    assert.equal(written.ok ? decoder.decode(written.value) : '', '{"SucRua-run-3f1c2a9e":{}}');
  });

  it('refuses an invocation without the option it must write to, and a path it cannot write', async () => {
    const files = new MemoryAssemblyFileSystem();
    const runner = new FakeCommandRunner(files);
    const deploy = cdkDeployInvocation(tools('/w'), '/w/copy', 'SucRua-run-3f1c2a9e', '/w/outputs.json');
    await assert.rejects(
      runner.run({ ...deploy, args: deploy.args.slice(0, 4) }),
      /lacks --app; expected the option with a value/,
    );
    files.failCreate('/w/copy/read.4243.1.lock');
    await assert.rejects(runner.run(deploy), /could not write "\/w\/copy\/read\.4243\.1\.lock": IO_ERROR/);
  });
});
