// The frozen assembly and its verified deploy copy on real disk (design §9.8 S1, D1-D3; D-25;
// BR-RUA-042; RF V1, RK-13; AC-RUA-053 "a deploy copy that never touches the package").
// - S1: the pinned CDK CLI synthesizes once through CdkAssemblySynthesizer, the local subprocess
//   runner and file system, under the Docker sentinel and without AWS variables, and leaves the
//   template and manifest with no lock file; a synthesis the app refuses is SYNTH_FAILED.
// - D1-D3: a frozen package copy is copied to the temporary deploy directory with its exact
//   permission bits, proven equal to its inventory, deployed by the scripted CLI, whose read lock
//   lands in the copy only, and the package re-verifies unchanged; a changed byte, a changed mode,
//   a link or a file added to the package, and a stale deploy directory are each refused.
// The D1-D3 assembly is a small fixture: the inventory's text scan refuses every real bundle
// (finding reported to WP-13 on 2026-10-06; see platform-constraints case 4g).

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import { readAssemblyListing } from '../../../src/deployment-assembly/assembly-listing.ts';
import { verifyAssemblyUnchanged } from '../../../src/deployment-assembly/assembly-verification.ts';
import { CdkAssemblyDeployer } from '../../../src/deployment-assembly/cdk-assembly-deployer.ts';
import { CdkAssemblySynthesizer } from '../../../src/deployment-assembly/cdk-assembly-synthesizer.ts';
import type { CdkToolSettings } from '../../../src/deployment-assembly/cdk-invocations.ts';
import { prepareVerifiedDeployCopy } from '../../../src/deployment-assembly/deploy-copy.ts';
import { ChildProcessCommandRunner } from '../../../src/deployment-assembly/node/child-process-command-runner.ts';
import { NodeAssemblyFileSystem } from '../../../src/deployment-assembly/node/node-assembly-file-system.ts';
import type { DeploymentAssemblyInventory } from '../../../src/record-contract/records/group-a/deployment_assembly_inventory.ts';
import {
  ASSEMBLY_FILES,
  frozenInventory,
  placeAssembly,
  RUN_STACK,
  SteppingWallClock,
  synthContext,
} from '../../support/deployment-assembly/deployment-fixtures.ts';
import { DiskCommandEffects } from '../../support/deployment-assembly/disk-command-effects.ts';
import { FakeCommandRunner } from '../../support/deployment-assembly/fake-command-runner.ts';
import { DOCKER_SENTINEL, STUDY_ROOT } from '../../support/deployment-assembly/study-synth.ts';

const files = new NodeAssemblyFileSystem();
const directories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rua-frozen-'));
  directories.push(root);
  return root;
}

function tools(): CdkToolSettings {
  return {
    node_executable: process.execPath,
    cdk_cli_entry: join(STUDY_ROOT, 'node_modules/aws-cdk/bin/cdk'),
    study_root: STUDY_ROOT,
    docker_sentinel: DOCKER_SENTINEL,
    environment: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      AWS_ACCESS_KEY_ID: 'AKIASHOULDNOTREACH',
      AWS_SECRET_ACCESS_KEY: 'should-not-reach',
      AWS_PROFILE: 'operator',
    },
  };
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('S1: one synthesis by the pinned CLI', () => {
  let staging = '';
  let report: Awaited<ReturnType<CdkAssemblySynthesizer['synthesize']>>;

  before(async () => {
    staging = join(temporaryRoot(), 'attempt/staging');
    const synthesizer = new CdkAssemblySynthesizer({ runner: new ChildProcessCommandRunner(), files, tools: tools() });
    report = await synthesizer.synthesize(synthContext('TRANSPORT_PROBE'), staging);
  });

  it('writes the template and manifest into the staging assembly and leaves no lock file', () => {
    assert.ok(report.ok, JSON.stringify(report.ok ? {} : report.error));
    assert.deepEqual(report.value, {
      assembly_dir: join(staging, 'cdk.out'),
      stack_name: 'SucRua-probe-3f1c2a9e',
      template_file: 'SucRua-probe-3f1c2a9e.template.json',
      context_file: join(staging, 'execution-context.json'),
    });
    const names = readdirSync(report.value.assembly_dir);
    assert.ok(names.includes('manifest.json') && names.includes('SucRua-probe-3f1c2a9e.template.json'));
    assert.deepEqual(
      names.filter((name) => name.endsWith('.lock')),
      [],
    );
    const template = JSON.parse(readFileSync(join(report.value.assembly_dir, report.value.template_file), 'utf8')) as {
      readonly Resources: Readonly<Record<string, { readonly Metadata?: Readonly<Record<string, string>> }>>;
    };
    assert.ok(
      Object.values(template.Resources).every((resource) =>
        resource.Metadata?.['aws:cdk:path']?.startsWith('SucRua-probe-3f1c2a9e/'),
      ),
    );
  });

  it('writes nothing outside the staging directory but the context file and the assembly', () => {
    assert.deepEqual(readdirSync(staging).toSorted(), ['cdk.out', 'execution-context.json']);
  });

  it('reports SYNTH_FAILED when the app refuses its context', async () => {
    const refused = join(temporaryRoot(), 'attempt/staging');
    const synthesizer = new CdkAssemblySynthesizer({ runner: new ChildProcessCommandRunner(), files, tools: tools() });
    const invalid = { ...synthContext('RUN'), region: 'eu-west-1' } as unknown as ExecutionSynthContext;
    const failed = await synthesizer.synthesize(invalid, refused);
    assert.equal(failed.ok ? 'ok' : failed.error.code, 'SYNTH_FAILED');
    assert.match(
      failed.ok ? '' : failed.error.detail,
      /^cdk synth exited with status 1; stderr tail: .*invalid execution context/s,
    );
  });
});

interface FrozenRig {
  readonly packageDir: string;
  readonly copyDir: string;
  readonly inventory: DeploymentAssemblyInventory;
}

async function frozenRig(): Promise<FrozenRig> {
  const root = temporaryRoot();
  const packageDir = join(root, 'evidence/runs/x/admission/deployment-assembly');
  await placeAssembly(files, packageDir);
  return {
    packageDir,
    copyDir: join(root, 'study-1/.deploy-staging/x'),
    inventory: await frozenInventory(files, packageDir),
  };
}

async function packageReasons(rig: FrozenRig): Promise<readonly string[]> {
  const listing = await readAssemblyListing(files, rig.packageDir);
  assert.ok(listing.ok);
  return verifyAssemblyUnchanged(rig.inventory, listing.value).map((reason) => reason.code);
}

describe('D1-D3: the verified deploy copy on disk', () => {
  it('deploys from the copy, whose lock file never reaches the package, and the package re-verifies', async () => {
    const rig = await frozenRig();
    const copy = await prepareVerifiedDeployCopy(rig.packageDir, rig.inventory, rig.copyDir, files);
    assert.ok(copy.ok, JSON.stringify(copy.ok ? [] : copy.error));
    const modes = ASSEMBLY_FILES.map((file) => [file.path, file.mode]);
    assert.deepEqual(
      rig.inventory.files.map((file) => [file.path, Number.parseInt(file.mode, 8)]),
      modes.toSorted((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
    );
    const runner = new FakeCommandRunner(new DiskCommandEffects());
    runner.enqueue({ kind: 'signalled', signal: 'SIGKILL', stdout: '', stderr: '' });
    const deployer = new CdkAssemblyDeployer({ runner, files, tools: tools(), clock: new SteppingWallClock() });
    const report = await deployer.deploy(copy.value, RUN_STACK, join(rig.copyDir, '..', 'outputs.json'));
    assert.equal(report.deployed, false);
    const [lock] = runner.locksWritten();
    assert.equal(lock, join(rig.copyDir, 'read.4242.1.lock'));
    assert.ok(readdirSync(rig.copyDir).includes('read.4242.1.lock'));
    assert.deepEqual(await packageReasons(rig), []);
    const copyListing = await readAssemblyListing(files, rig.copyDir);
    assert.ok(copyListing.ok);
    assert.deepEqual(
      verifyAssemblyUnchanged(rig.inventory, copyListing.value).map((reason) => reason.code),
      ['FILE_ADDED'],
    );
  });

  it('writes the outputs of a successful deployment and keeps the package unchanged', async () => {
    const rig = await frozenRig();
    const copy = await prepareVerifiedDeployCopy(rig.packageDir, rig.inventory, rig.copyDir, files);
    assert.ok(copy.ok);
    const runner = new FakeCommandRunner(new DiskCommandEffects());
    runner.scriptDeployOutputs(`{"${RUN_STACK}":{"ProviderVersion":"7"}}`);
    const deployer = new CdkAssemblyDeployer({ runner, files, tools: tools(), clock: new SteppingWallClock() });
    const report = await deployer.deploy(copy.value, RUN_STACK, join(rig.copyDir, '..', 'outputs.json'));
    assert.deepEqual([report.deployed, report.outputs], [true, [{ key: 'ProviderVersion', value: '7' }]]);
    assert.deepEqual(await packageReasons(rig), []);
    assert.equal(
      readdirSync(rig.copyDir).some((name) => name.endsWith('.lock')),
      false,
    );
  });

  it('refuses a package whose bytes or mode changed after freezing', async () => {
    const changed = await frozenRig();
    const bundle = join(changed.packageDir, 'asset.abc123/index.mjs');
    writeFileSync(bundle, 'export const handler = () => 2;\n');
    const first = await prepareVerifiedDeployCopy(changed.packageDir, changed.inventory, changed.copyDir, files);
    assert.deepEqual(first.ok ? [] : first.error.map((reason) => reason.code), [
      'DEPLOY_COPY_NOT_VERIFIED',
      'FILE_CHANGED',
    ]);
    assert.deepEqual(await packageReasons(changed), ['FILE_CHANGED']);
    const remoded = await frozenRig();
    chmodSync(join(remoded.packageDir, 'asset.abc123/run.sh'), 0o644);
    const second = await prepareVerifiedDeployCopy(remoded.packageDir, remoded.inventory, remoded.copyDir, files);
    assert.match(second.ok ? '' : (second.error[1]?.detail ?? ''), /has mode 0644 \(frozen 0755\)/);
  });

  it('refuses a link swapped in for a frozen file, and a link or file added to the package', async () => {
    const swapped = await frozenRig();
    rmSync(join(swapped.packageDir, 'manifest.json'));
    symlinkSync('/etc/hosts', join(swapped.packageDir, 'manifest.json'));
    const copy = await prepareVerifiedDeployCopy(swapped.packageDir, swapped.inventory, swapped.copyDir, files);
    assert.deepEqual(copy.ok ? [] : copy.error.map((reason) => reason.code), ['FROZEN_FILE_MISSING']);
    const linked = await frozenRig();
    symlinkSync('/etc/hosts', join(linked.packageDir, 'escape'));
    writeFileSync(join(linked.packageDir, 'read.1.1.lock'), '1');
    assert.deepEqual(await packageReasons(linked), ['NON_REGULAR_FILE']);
  });

  it('refuses a deploy directory that already holds files', async () => {
    const rig = await frozenRig();
    await placeAssembly(files, rig.copyDir);
    const copy = await prepareVerifiedDeployCopy(rig.packageDir, rig.inventory, rig.copyDir, files);
    assert.deepEqual(copy.ok ? [] : copy.error.map((reason) => reason.code), ['DEPLOY_COPY_NOT_EMPTY']);
  });
});
