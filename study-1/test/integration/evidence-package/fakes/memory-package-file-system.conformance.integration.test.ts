// Conformance of MemoryPackageFileSystem: the shared PackageFileSystem suite runs against the real
// NodePackageFileSystem in a temporary directory and against the emulator, so the emulator cannot
// drift from the binding it replaces. The emulator's test hooks are checked against the outcome a
// real failure would give.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NodePackageFileSystem } from '../../../../src/evidence-package/node/node-package-file-system.ts';
import { MemoryPackageFileSystem } from '../../../support/evidence-package/memory-package-file-system.ts';
import { describePackageFileSystemConformance } from '../../../support/evidence-package/package-file-system-conformance.ts';
import type { PackageFileSystemUnderTest } from '../../../support/evidence-package/package-file-system-conformance.ts';

const directories: string[] = [];
const encoder = new TextEncoder();

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describePackageFileSystemConformance('NodePackageFileSystem', (): PackageFileSystemUnderTest => {
  const root = mkdtempSync(join(tmpdir(), 'rua-package-fs-'));
  directories.push(root);
  return {
    fs: new NodePackageFileSystem(root),
    placeSymlink: (path, target): Promise<void> => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      symlinkSync(target, join(root, path));
      return Promise.resolve();
    },
  };
});

describePackageFileSystemConformance('MemoryPackageFileSystem', (): PackageFileSystemUnderTest => {
  const fs = new MemoryPackageFileSystem();
  return {
    fs,
    placeSymlink: (path): Promise<void> => {
      fs.placeSpecial(path, 'symlink');
      return Promise.resolve();
    },
  };
});

describe('MemoryPackageFileSystem test hooks', () => {
  it('corrupt flips one stored byte and refuses an offset outside the file', async () => {
    const fs = new MemoryPackageFileSystem();
    await fs.writeOnce('p/a.json', Uint8Array.of(0x00, 0x0f));
    fs.corrupt('p/a.json', 1);
    assert.deepEqual(await fs.read('p/a.json'), { ok: true, value: Uint8Array.of(0x00, 0xf0) });
    assert.throws(() => {
      fs.corrupt('p/a.json', 2);
    }, /expected a stored file and an offset inside it/);
    assert.throws(() => {
      fs.corrupt('p/absent.json', 0);
    }, /expected a stored file/);
  });

  it('failReads and failLists return the scripted failure', async () => {
    const fs = new MemoryPackageFileSystem();
    await fs.writeOnce('p/a.json', encoder.encode('{}'));
    fs.failReads('p/a.json', 'IO_ERROR');
    fs.failLists('p', 'IO_ERROR');
    const read = await fs.read('p/a.json');
    const listed = await fs.list('p');
    assert.deepEqual(
      [read.ok ? 'ok' : read.error.code, listed.ok ? 'ok' : listed.error.code],
      ['IO_ERROR', 'IO_ERROR'],
    );
  });

  it('refuses to read a directory, as the local binding does', async () => {
    const fs = new MemoryPackageFileSystem();
    await fs.writeOnce('p/q/a.json', encoder.encode('{}'));
    const read = await fs.read('p/q');
    assert.equal(read.ok ? 'ok' : read.error.code, 'IO_ERROR');
    const node = new NodePackageFileSystem(mkdtempSync(join(tmpdir(), 'rua-package-fs-')));
    await node.writeOnce('p/q/a.json', encoder.encode('{}'));
    const nodeRead = await node.read('p/q');
    assert.equal(nodeRead.ok ? 'ok' : nodeRead.error.code, 'IO_ERROR');
  });
});
