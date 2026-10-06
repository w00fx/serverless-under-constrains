// Conformance of the finalize-refusing storage: package files and appends behave as the offline
// storage's, and every finalize is refused with the scripted code, leaving the file appendable.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FinalizeRefusingPackageStorage } from './finalize-refusing-package-storage.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('FinalizeRefusingPackageStorage', () => {
  it('refuses every finalize with the scripted code and records the path', async () => {
    const storage = new FinalizeRefusingPackageStorage('EROFS');
    await storage.append('root/j.jsonl', bytes('a\n'));
    assert.deepEqual(await storage.finalize('root/j.jsonl'), { kind: 'failed', code: 'EROFS' });
    assert.deepEqual(await storage.append('root/j.jsonl', bytes('b\n')), { kind: 'appended' });
    assert.deepEqual(storage.refused(), ['root/j.jsonl']);
  });

  it('writes and reads package files like the offline storage', async () => {
    const storage = new FinalizeRefusingPackageStorage();
    assert.equal((await storage.writeOnce('root/a.json', bytes('a'))).ok, true);
    assert.equal((await storage.writeOnce('root/a.json', bytes('b'))).ok, false);
    assert.deepEqual(storage.filesUnder('root').get('a.json'), bytes('a'));
    assert.deepEqual(await storage.finalize('root/x'), { kind: 'failed', code: 'EPERM' });
  });
});
