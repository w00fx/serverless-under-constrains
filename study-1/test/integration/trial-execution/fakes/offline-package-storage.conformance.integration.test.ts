// Conformance of OfflinePackageStorage: the shared PackageFileSystem and AppendOnlyFile suites,
// which also run against the real NodePackageFileSystem and NodeAppendOnlyFile, run against it, so
// the one in-memory evidence root behind both ports cannot drift from either binding. Its test
// hooks are checked against the outcome a real failure would give.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppendOnlyFileUnderTest } from '../../../support/event-journal/append-only-file-conformance.ts';
import { describeAppendOnlyFileConformance } from '../../../support/event-journal/append-only-file-conformance.ts';
import { describePackageFileSystemConformance } from '../../../support/evidence-package/package-file-system-conformance.ts';
import type { PackageFileSystemUnderTest } from '../../../support/evidence-package/package-file-system-conformance.ts';
import { OfflinePackageStorage } from '../../../support/offline-cloud/offline-package-storage.ts';

const encoder = new TextEncoder();

describePackageFileSystemConformance('OfflinePackageStorage', (): PackageFileSystemUnderTest => {
  const storage = new OfflinePackageStorage();
  return {
    fs: storage,
    placeSymlink: (path): Promise<void> => {
      storage.placeSymlink(path);
      return Promise.resolve();
    },
  };
});

describeAppendOnlyFileConformance('OfflinePackageStorage', (): AppendOnlyFileUnderTest => {
  const storage = new OfflinePackageStorage();
  return {
    file: storage,
    path: (name) => `offline/${name}`,
    read: async (path): Promise<Uint8Array | undefined> => {
      const read = await storage.read(path);
      return read.ok ? read.value : undefined;
    },
    seedRaw: (path, bytes): Promise<void> => {
      storage.seedRaw(path, bytes);
      return Promise.resolve();
    },
  };
});

describe('OfflinePackageStorage as one evidence root', () => {
  it('lists and reads an appended journal with the package files', async () => {
    const storage = new OfflinePackageStorage();
    await storage.writeOnce('runs/r/trials/t/trial-manifest.json', encoder.encode('{}'));
    await storage.append('runs/r/runner/runner-journal.jsonl', encoder.encode('{"a":1}\n'));
    const listed = await storage.list('runs/r');
    assert.deepEqual(
      listed.ok ? listed.value.filter((entry) => entry.type === 'file').map((entry) => entry.path) : [],
      ['runner/runner-journal.jsonl', 'trials/t/trial-manifest.json'],
    );
    assert.deepEqual(
      [...storage.filesUnder('runs/r').keys()],
      ['runner/runner-journal.jsonl', 'trials/t/trial-manifest.json'],
    );
  });

  it('refuses to write a file over a directory, and an append after finalize', async () => {
    const storage = new OfflinePackageStorage();
    await storage.writeOnce('p/q/a.json', encoder.encode('{}'));
    const conflict = await storage.writeOnce('p/q', encoder.encode('{}'));
    assert.equal(conflict.ok ? 'ok' : conflict.error.code, 'ALREADY_EXISTS');
    await storage.finalize('p/j.jsonl');
    assert.equal((await storage.append('p/j.jsonl', encoder.encode('x\n'))).kind, 'not_written');
  });

  it('failNextLists fails exactly that many listings with IO_ERROR', async () => {
    const storage = new OfflinePackageStorage();
    await storage.writeOnce('p/a.json', encoder.encode('{}'));
    storage.failNextLists(2);
    const codes: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await storage.list('p');
      codes.push(listed.ok ? 'ok' : listed.error.code);
    }
    assert.deepEqual(codes, ['IO_ERROR', 'IO_ERROR', 'ok']);
  });
});
