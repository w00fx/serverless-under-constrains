// Reading and copying an assembly directory over the `AssemblyFileSystem` port (BR-RUA-042): a
// listing or read failure names the path; a copy reproduces bytes and permission bits and names
// the file it could not write.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { copyAssemblyDirectory, readAssemblyDirectory } from '../../../src/admission/assembly-files.ts';
import { MemoryAssemblyFileSystem } from '../../support/deployment-assembly/memory-assembly-file-system.ts';

const encoder = new TextEncoder();

async function stagedAssembly(): Promise<MemoryAssemblyFileSystem> {
  const files = new MemoryAssemblyFileSystem();
  await files.createFile('/staging/cdk.out/manifest.json', encoder.encode('{}\n'), 0o644);
  await files.createFile('/staging/cdk.out/asset.1/run.sh', encoder.encode('#!/bin/sh\n'), 0o755);
  return files;
}

describe('readAssemblyDirectory', () => {
  it('lists every entry and reads every regular file with its permission bits', async () => {
    const files = await stagedAssembly();
    files.placeSpecial('/staging/cdk.out/link', 'symlink');
    const read = await readAssemblyDirectory(files, '/staging/cdk.out');
    assert.ok(read.ok);
    assert.deepEqual(
      read.value.files.map(({ path, mode }) => [path, mode]),
      [
        ['asset.1/run.sh', 0o755],
        ['manifest.json', 0o644],
      ],
    );
    assert.ok(read.value.entries.some((entry) => entry.path === 'link' && entry.type === 'symlink'));
  });

  it('names a directory it cannot list and a file it cannot read', async () => {
    const files = await stagedAssembly();
    files.failList('/staging/cdk.out');
    const listed = await readAssemblyDirectory(files, '/staging/cdk.out');
    assert.ok(!listed.ok);
    assert.equal(listed.error.code, 'ASSEMBLY_UNREADABLE');
    assert.match(listed.error.detail, /^\/staging\/cdk\.out could not be read \(IO_ERROR: scripted list failure/);
    const unreadable = await stagedAssembly();
    unreadable.failRead('/staging/cdk.out/manifest.json');
    const read = await readAssemblyDirectory(unreadable, '/staging/cdk.out');
    assert.ok(!read.ok);
    assert.match(read.error.detail, /^\/staging\/cdk\.out\/manifest\.json could not be read \(IO_ERROR: /);
  });
});

describe('copyAssemblyDirectory', () => {
  it('reproduces bytes and permission bits, and names a file it cannot write', async () => {
    const files = await stagedAssembly();
    const read = await readAssemblyDirectory(files, '/staging/cdk.out');
    assert.ok(read.ok);
    assert.equal(await copyAssemblyDirectory(read.value, '/package/frozen', files), undefined);
    const copied = await readAssemblyDirectory(files, '/package/frozen');
    assert.ok(copied.ok);
    assert.deepEqual(copied.value.files, read.value.files);
    files.failCreate('/package/again/manifest.json');
    const reason = await copyAssemblyDirectory(read.value, '/package/again', files);
    assert.ok(reason !== undefined);
    assert.equal(reason.code, 'ASSEMBLY_COPY_FAILED');
    assert.match(
      reason.detail,
      /^writing \/package\/again\/manifest\.json failed with IO_ERROR: .*; expected a new file$/,
    );
  });
});
