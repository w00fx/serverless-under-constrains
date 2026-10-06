// Conformance of MemoryInstalledPackageReader with NodeModulesPackageReader over the same
// installed tree (design §12.2): an installed package reads as its manifest version, nested and
// scoped installs included, and every path with no installed manifest reads as undefined.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { NodeModulesPackageReader } from '../../../../../src/transport-qualification/scope/node/node-modules-package-reader.ts';
import type { InstalledPackageReader } from '../../../../../src/transport-qualification/scope/scope-recomputation.ts';
import { MemoryInstalledPackageReader } from '../../../../unit/transport-qualification/scope/support/memory-installed-package-reader.ts';
import { TemporaryScopeProject } from '../support/temporary-scope-project.ts';

const INSTALLED: Readonly<Record<string, string>> = {
  'node_modules/transport-dep': '1.0.0',
  'node_modules/@scope/declared-dep': '4.1.0',
  'node_modules/transport-dep/node_modules/@inner/helper': '2.0.0',
};

const READS = [
  'node_modules/transport-dep',
  'node_modules/@scope/declared-dep',
  'node_modules/transport-dep/node_modules/@inner/helper',
  'node_modules/absent',
  'node_modules/@scope',
  'node_modules/transport-dep/index.js',
] as const;

describe('MemoryInstalledPackageReader conformance with NodeModulesPackageReader', () => {
  let project: TemporaryScopeProject;
  let disk: InstalledPackageReader;
  let memory: InstalledPackageReader;

  before(() => {
    project = TemporaryScopeProject.create({});
    for (const [installPath, version] of Object.entries(INSTALLED)) {
      project.installPackage(installPath.slice('node_modules/'.length), version, 'export {};\n');
    }
    disk = new NodeModulesPackageReader({ projectRoot: project.projectRoot });
    memory = new MemoryInstalledPackageReader(INSTALLED);
  });

  after(() => {
    project.dispose();
  });

  for (const installPath of READS) {
    it(`reads the same version for ${installPath}`, async () => {
      assert.deepEqual(await memory.installedVersion(installPath), await disk.installedVersion(installPath));
    });
  }
});

describe('MemoryInstalledPackageReader controls', () => {
  it('installs, uninstalls and records reads', async () => {
    const reader = new MemoryInstalledPackageReader({ 'node_modules/a': '1.0.0' });
    reader.install('node_modules/b', '2.0.0');
    reader.install('node_modules/a', '1.1.0');
    reader.uninstall('node_modules/b');
    assert.equal(await reader.installedVersion('node_modules/a'), '1.1.0');
    assert.equal(await reader.installedVersion('node_modules/b'), undefined);
    assert.deepEqual(reader.reads(), ['node_modules/a', 'node_modules/b']);
  });

  it('scripts read failures of one install path or of every read', async () => {
    const reader = new MemoryInstalledPackageReader({ 'node_modules/a': '1.0.0', 'node_modules/b': '2.0.0' });
    reader.failWith('b unreadable', 'node_modules/b');
    assert.equal(await reader.installedVersion('node_modules/a'), '1.0.0');
    await assert.rejects(reader.installedVersion('node_modules/b'), /^Error: b unreadable$/);
    reader.failWith('all unreadable');
    await assert.rejects(reader.installedVersion('node_modules/a'), /^Error: all unreadable$/);
  });
});
