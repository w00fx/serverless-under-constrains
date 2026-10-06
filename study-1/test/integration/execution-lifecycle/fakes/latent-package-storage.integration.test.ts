// Conformance of the latent evidence root: it keeps the wrapped storage's write-once, read, list,
// append and finalize semantics, and only file creation waits the latency in virtual time.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SelfAdvancingSleeper } from '../../../support/cleanup/self-advancing-sleeper.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { OfflinePackageStorage } from '../../../support/offline-cloud/offline-package-storage.ts';
import { LatentPackageStorage } from './latent-package-storage.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function latent(): { storage: LatentPackageStorage; time: VirtualTimeScheduler } {
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12, 0, 0, 0) });
  return {
    storage: new LatentPackageStorage(new OfflinePackageStorage(), new SelfAdvancingSleeper(time), 2_000),
    time,
  };
}

describe('LatentPackageStorage', () => {
  it('creates a file after the latency, once', async () => {
    const { storage, time } = latent();
    assert.deepEqual(await storage.writeOnce('root/a.json', bytes('a')), { ok: true, value: undefined });
    assert.equal(time.now().toISOString(), '2026-10-05T12:00:02.000Z');
    const again = await storage.writeOnce('root/a.json', bytes('b'));
    assert.equal(again.ok, false);
    assert.equal(storage.writes(), 2);
    const read = await storage.read('root/a.json');
    assert.deepEqual(read.ok && read.value, bytes('a'));
  });

  it('lists, appends and finalizes without delay', async () => {
    const { storage, time } = latent();
    assert.deepEqual(await storage.append('root/j.jsonl', bytes('x\n')), { kind: 'appended' });
    assert.deepEqual(await storage.finalize('root/j.jsonl'), { kind: 'finalized' });
    const listed = await storage.list('root');
    assert.deepEqual(listed.ok && listed.value.map((entry) => entry.path), ['j.jsonl']);
    assert.equal(time.now().toISOString(), '2026-10-05T12:00:00.000Z');
    assert.equal(storage.writes(), 0);
  });
});
