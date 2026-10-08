// The AssemblyFileSystem conformance suite. It runs unchanged against the local binding
// `NodeAssemblyFileSystem` in a temporary directory and against the `MemoryAssemblyFileSystem`
// emulator, so the emulator is held to the behavior of the real binding: creation with parent
// directories and exactly the given permission bits whatever the umask, refusal of an existing
// path, exact byte reads, a sorted recursive listing with directories and links, links listed but
// never read, and the failure codes of an absent path, a directory and a file listed as one.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { AssemblyFileSystem } from '../../../src/deployment-assembly/assembly-file-system.ts';

export interface AssemblyFileSystemUnderTest {
  readonly fs: AssemblyFileSystem;
  /** An absolute directory the subject may write below. */
  readonly root: string;
  /** Creates a symbolic link at the absolute `path` pointing at the absolute `target`. */
  readonly placeSymlink: (path: string, target: string) => Promise<void>;
}

const REGULAR_FILE = 0o100000;
const encoder = new TextEncoder();

function failureCode(
  result:
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly code: string } },
): string {
  return result.ok ? 'ok' : result.error.code;
}

/**
 * Declares the conformance cases for one implementation.
 *
 * @example
 * describeAssemblyFileSystemConformance('MemoryAssemblyFileSystem', () => memorySubject());
 */
export function describeAssemblyFileSystemConformance(
  name: string,
  subjectFactory: () => AssemblyFileSystemUnderTest,
): void {
  describe(`${name} conforms to the AssemblyFileSystem contract`, () => {
    it('creates a file with its parents and reads back the exact bytes', async () => {
      const { fs, root } = subjectFactory();
      const bytes = Uint8Array.of(0, 1, 2, 0xff, 0x0a);
      const path = join(root, 'copy/asset.abc/index.mjs');
      assert.deepEqual(await fs.createFile(path, bytes, 0o644), { ok: true, value: undefined });
      assert.deepEqual(await fs.read(path), { ok: true, value: bytes });
    });

    it('keeps exactly the given permission bits, past the umask', async () => {
      const { fs, root } = subjectFactory();
      await fs.createFile(join(root, 'a/open.json'), encoder.encode('{}'), 0o666);
      await fs.createFile(join(root, 'a/run.sh'), encoder.encode('x'), 0o755);
      await fs.createFile(join(root, 'a/private.json'), encoder.encode('{}'), 0o600);
      const listed = await fs.list(join(root, 'a'));
      assert.ok(listed.ok);
      assert.deepEqual(
        listed.value.map((entry) => [entry.path, entry.mode]),
        [
          ['open.json', REGULAR_FILE | 0o666],
          ['private.json', REGULAR_FILE | 0o600],
          ['run.sh', REGULAR_FILE | 0o755],
        ],
      );
    });

    it('refuses to overwrite an existing file and keeps the first bytes', async () => {
      const { fs, root } = subjectFactory();
      const path = join(root, 'a/file.json');
      await fs.createFile(path, encoder.encode('first'), 0o644);
      const second = await fs.createFile(path, encoder.encode('second'), 0o644);
      assert.equal(failureCode(second), 'ALREADY_EXISTS');
      assert.deepEqual(await fs.read(path), { ok: true, value: encoder.encode('first') });
    });

    it('lists every entry below a directory, sorted, with directories and without the directory', async () => {
      const { fs, root } = subjectFactory();
      await fs.createFile(join(root, 'out/b/two.json'), encoder.encode('2'), 0o644);
      await fs.createFile(join(root, 'out/b.json'), encoder.encode('b'), 0o644);
      await fs.createFile(join(root, 'out/a.json'), encoder.encode('1'), 0o644);
      await fs.createFile(join(root, 'other/x.json'), encoder.encode('x'), 0o644);
      const listed = await fs.list(join(root, 'out'));
      assert.ok(listed.ok);
      assert.deepEqual(
        listed.value.map((entry) => [entry.path, entry.type]),
        [
          ['a.json', 'file'],
          ['b', 'directory'],
          ['b.json', 'file'],
          ['b/two.json', 'file'],
        ],
      );
    });

    it('lists a symbolic link as a link and refuses to read through it', async () => {
      const { fs, root, placeSymlink } = subjectFactory();
      await fs.createFile(join(root, 'out/real.json'), encoder.encode('{}'), 0o644);
      await placeSymlink(join(root, 'out/link.json'), join(root, 'out/real.json'));
      const listed = await fs.list(join(root, 'out'));
      assert.ok(listed.ok);
      assert.deepEqual(
        listed.value.map((entry) => [entry.path, entry.type]),
        [
          ['link.json', 'symlink'],
          ['real.json', 'file'],
        ],
      );
      assert.equal(failureCode(await fs.read(join(root, 'out/link.json'))), 'IO_ERROR');
    });

    it('reports NOT_FOUND for an absent directory or file', async () => {
      const { fs, root } = subjectFactory();
      assert.equal(failureCode(await fs.list(join(root, 'absent'))), 'NOT_FOUND');
      assert.equal(failureCode(await fs.read(join(root, 'absent.json'))), 'NOT_FOUND');
    });

    it('refuses to read a directory or list a file', async () => {
      const { fs, root } = subjectFactory();
      await fs.createFile(join(root, 'd/f.json'), encoder.encode('{}'), 0o644);
      assert.equal(failureCode(await fs.read(join(root, 'd'))), 'IO_ERROR');
      assert.equal(failureCode(await fs.list(join(root, 'd/f.json'))), 'IO_ERROR');
    });
  });
}
