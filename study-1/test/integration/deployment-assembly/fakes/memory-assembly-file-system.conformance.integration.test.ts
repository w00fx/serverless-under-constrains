// Conformance of MemoryAssemblyFileSystem: the shared AssemblyFileSystem suite runs against the real
// NodeAssemblyFileSystem in a temporary directory and against the emulator, so the emulator cannot
// drift from the binding it replaces. The emulator's test hooks are checked against the outcome a
// real special file or failure gives the local binding.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NodeAssemblyFileSystem } from '../../../../src/deployment-assembly/node/node-assembly-file-system.ts';
import { describeAssemblyFileSystemConformance } from '../../../support/deployment-assembly/assembly-file-system-conformance.ts';
import type { AssemblyFileSystemUnderTest } from '../../../support/deployment-assembly/assembly-file-system-conformance.ts';
import { MemoryAssemblyFileSystem } from '../../../support/deployment-assembly/memory-assembly-file-system.ts';

const directories: string[] = [];
const encoder = new TextEncoder();

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'rua-assembly-fs-'));
  directories.push(root);
  return root;
}

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describeAssemblyFileSystemConformance('NodeAssemblyFileSystem', (): AssemblyFileSystemUnderTest => ({
  fs: new NodeAssemblyFileSystem(),
  root: temporaryRoot(),
  placeSymlink: (path, target): Promise<void> => {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
    return Promise.resolve();
  },
}));

describeAssemblyFileSystemConformance('MemoryAssemblyFileSystem', (): AssemblyFileSystemUnderTest => {
  const fs = new MemoryAssemblyFileSystem();
  return {
    fs,
    root: '/work',
    placeSymlink: (path): Promise<void> => {
      fs.placeSpecial(path, 'symlink');
      return Promise.resolve();
    },
  };
});

describe('MemoryAssemblyFileSystem test hooks', () => {
  it('placeSpecial lists a FIFO as the local binding lists a real one, and neither reads it', async () => {
    const root = temporaryRoot();
    execFileSync('mkfifo', [join(root, 'pipe')]);
    const node = new NodeAssemblyFileSystem();
    const memory = new MemoryAssemblyFileSystem();
    memory.placeSpecial('/work/pipe', 'fifo');
    const nodeListed = await node.list(root);
    const memoryListed = await memory.list('/work');
    assert.ok(nodeListed.ok && memoryListed.ok);
    assert.deepEqual(
      nodeListed.value.map((entry) => [entry.path, entry.type]),
      memoryListed.value.map((entry) => [entry.path, entry.type]),
    );
    const nodeRead = await node.read(join(root, 'pipe'));
    const memoryRead = await memory.read('/work/pipe');
    assert.deepEqual([nodeRead.ok, memoryRead.ok], [false, false]);
  });

  it('failList, failRead and failCreate return IO_ERROR for that path only', async () => {
    const fs = new MemoryAssemblyFileSystem();
    await fs.createFile('/w/a.json', encoder.encode('{}'), 0o644);
    fs.failList('/w');
    fs.failRead('/w/a.json');
    fs.failCreate('/w/b.json');
    const codes = [
      await fs.list('/w'),
      await fs.read('/w/a.json'),
      await fs.createFile('/w/b.json', encoder.encode('x'), 0o644),
    ].map((result) => (result.ok ? 'ok' : result.error.code));
    assert.deepEqual(codes, ['IO_ERROR', 'IO_ERROR', 'IO_ERROR']);
    assert.equal((await fs.createFile('/w/c.json', encoder.encode('x'), 0o644)).ok, true);
  });

  it('corrupt and setMode change a stored file, and refuse a path that is not one', async () => {
    const fs = new MemoryAssemblyFileSystem();
    await fs.createFile('/w/a.json', Uint8Array.of(0x0f, 0x01), 0o644);
    fs.corrupt('/w/a.json');
    fs.setMode('/w/a.json', 0o600);
    assert.deepEqual(await fs.read('/w/a.json'), { ok: true, value: Uint8Array.of(0xf0, 0x01) });
    const listed = await fs.list('/w');
    assert.deepEqual(listed.ok ? listed.value.map((entry) => entry.mode) : [], [0o100600]);
    assert.throws(() => {
      fs.corrupt('/w');
    }, /"\/w" is not a stored file/);
    assert.throws(() => {
      fs.setMode('/w/absent.json', 0o644);
    }, /expected a file created with createFile/);
  });

  it('corrupt refuses an empty file, which has no byte to flip', async () => {
    const fs = new MemoryAssemblyFileSystem();
    await fs.createFile('/w/empty', new Uint8Array(), 0o644);
    assert.throws(() => {
      fs.corrupt('/w/empty');
    }, /is empty; expected a stored file with a byte to flip/);
  });

  it('removeFile deletes an entry and ignores an absent one', async () => {
    const fs = new MemoryAssemblyFileSystem();
    await fs.createFile('/w/read.1.1.lock', encoder.encode('1'), 0o644);
    await fs.removeFile('/w/read.1.1.lock');
    await fs.removeFile('/w/absent');
    const listed = await fs.list('/w');
    assert.deepEqual(listed, { ok: true, value: [] });
  });
});
