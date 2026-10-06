// Conformance of the refusing storage: creations under a refused prefix and listings of a refused
// root fail with IO_ERROR and leave nothing behind; every other creation, read and list is the
// offline storage's.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RefusingPackageStorage } from './refusing-package-storage.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('RefusingPackageStorage', () => {
  it('refuses creations under the prefix and keeps nothing', async () => {
    const storage = new RefusingPackageStorage();
    storage.refuseWritesUnder('root/locked/');
    const refused = await storage.writeOnce('root/locked/a.json', bytes('a'));
    assert.equal(!refused.ok && refused.error.code, 'IO_ERROR');
    assert.match(!refused.ok ? refused.error.detail : '', /^ENOSPC: root\/locked\/a.json/);
    assert.equal(storage.filesUnder('root').size, 0);
  });

  it('refuses listing the refused root only', async () => {
    const storage = new RefusingPackageStorage();
    await storage.writeOnce('root/dir/a.json', bytes('a'));
    storage.refuseListing('root/dir');
    const refused = await storage.list('root/dir');
    assert.match(!refused.ok ? refused.error.detail : '', /^EACCES: root\/dir/);
    const listed = await storage.list('root');
    assert.deepEqual(listed.ok && listed.value.map((entry) => entry.path), ['dir', 'dir/a.json']);
  });

  it('creates files elsewhere as the offline storage does', async () => {
    const storage = new RefusingPackageStorage();
    storage.refuseWritesUnder('root/locked/');
    assert.equal((await storage.writeOnce('root/open/a.json', bytes('a'))).ok, true);
    assert.equal((await storage.writeOnce('root/open/a.json', bytes('b'))).ok, false);
    assert.deepEqual([...storage.filesUnder('root').keys()], ['open/a.json']);
  });
});
