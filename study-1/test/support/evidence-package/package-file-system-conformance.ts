// The PackageFileSystem conformance suite. It runs unchanged against the local binding
// `NodePackageFileSystem` in a temporary directory and against the `MemoryPackageFileSystem`
// emulator, so the emulator is held to the behavior of the real binding: write-once creation with
// parent directories, refusal of an existing path (BR-RUA-043), exact byte reads, sorted
// recursive listing with directories and symbolic links, and refusal of non-normalized paths.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PackageFileSystem } from '../../../src/evidence-package/package-file-system.ts';

export interface PackageFileSystemUnderTest {
  readonly fs: PackageFileSystem;
  /** Creates a symbolic link at `path` (relative to the root) that points at `target`. */
  placeSymlink(path: string, target: string): Promise<void>;
}

const encoder = new TextEncoder();

/**
 * Declares the conformance cases for one implementation.
 *
 * @example
 * describePackageFileSystemConformance('MemoryPackageFileSystem', () => memorySubject());
 */
export function describePackageFileSystemConformance(
  name: string,
  subjectFactory: () => PackageFileSystemUnderTest,
): void {
  describe(`${name} conforms to the PackageFileSystem contract`, () => {
    it('creates a file once with its parents and reads back the exact bytes', async () => {
      const { fs } = subjectFactory();
      const bytes = Uint8Array.of(0, 1, 2, 0xff, 0x0a);
      assert.deepEqual(await fs.writeOnce('runs/r/admission/manifest.json', bytes), { ok: true, value: undefined });
      assert.deepEqual(await fs.read('runs/r/admission/manifest.json'), { ok: true, value: bytes });
    });

    it('refuses to overwrite an existing file and keeps the first bytes', async () => {
      const { fs } = subjectFactory();
      await fs.writeOnce('a/file.json', encoder.encode('first'));
      const second = await fs.writeOnce('a/file.json', encoder.encode('second'));
      assert.equal(second.ok ? 'ok' : second.error.code, 'ALREADY_EXISTS');
      assert.deepEqual(await fs.read('a/file.json'), { ok: true, value: encoder.encode('first') });
    });

    it('lists every entry below a root, sorted, with directories and without the root', async () => {
      const { fs } = subjectFactory();
      await fs.writeOnce('pkg/b/two.json', encoder.encode('2'));
      await fs.writeOnce('pkg/a.json', encoder.encode('1'));
      await fs.writeOnce('other/x.json', encoder.encode('x'));
      const listed = await fs.list('pkg');
      assert.ok(listed.ok);
      assert.deepEqual(
        listed.value.map((entry) => [entry.path, entry.type]),
        [
          ['a.json', 'file'],
          ['b', 'directory'],
          ['b/two.json', 'file'],
        ],
      );
      assert.equal(listed.value[0]?.mode === undefined, false);
    });

    it('lists a symbolic link as a link and refuses to read through it', async () => {
      const subject = subjectFactory();
      await subject.fs.writeOnce('pkg/real.json', encoder.encode('{}'));
      await subject.placeSymlink('pkg/link.json', 'real.json');
      const listed = await subject.fs.list('pkg');
      assert.ok(listed.ok);
      assert.deepEqual(
        listed.value.map((entry) => [entry.path, entry.type]),
        [
          ['link.json', 'symlink'],
          ['real.json', 'file'],
        ],
      );
      const read = await subject.fs.read('pkg/link.json');
      assert.equal(read.ok, false);
    });

    it('reports a missing file or root as NOT_FOUND', async () => {
      const { fs } = subjectFactory();
      const read = await fs.read('absent/file.json');
      const listed = await fs.list('absent');
      assert.equal(read.ok ? 'ok' : read.error.code, 'NOT_FOUND');
      assert.equal(listed.ok ? 'ok' : listed.error.code, 'NOT_FOUND');
    });

    it('refuses absolute, parent-traversing and empty paths before touching storage', async () => {
      const { fs } = subjectFactory();
      for (const path of ['/etc/passwd', '../escape.json', 'a/../b.json', '']) {
        const written = await fs.writeOnce(path, encoder.encode('x'));
        const read = await fs.read(path);
        const listed = await fs.list(path);
        assert.deepEqual(
          [written, read, listed].map((result) => (result.ok ? 'ok' : result.error.code)),
          ['INVALID_PATH', 'INVALID_PATH', 'INVALID_PATH'],
          `path ${JSON.stringify(path)}`,
        );
      }
    });
  });
}
