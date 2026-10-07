// The local billing delivery reader over a real temporary directory (design §8.17; A-05): every
// entry below the directory, sorted by path, regular files with their exact bytes and a symbolic
// link listed without bytes and never followed; a missing directory fails with its errno code.
// This is also the conformance test of `MemoryDeliveryDirectory`: placed with the same entries, the
// fake answers exactly what the real reader read.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { NodeDeliveryDirectory } from '../../../src/operator-cli/node/node-delivery-directory.ts';
import { MemoryDeliveryDirectory } from '../../unit/operator-cli/support/memory-delivery-directory.ts';

const MANIFEST = new TextEncoder().encode('{"dataFiles":["data/part-00001.csv"]}');
const DATA = new Uint8Array([0x00, 0xff, 0x0a, 0x0d]);

describe('NodeDeliveryDirectory', () => {
  let scratch = '';
  let delivery = '';

  before(() => {
    scratch = mkdtempSync(join(tmpdir(), 'rua-delivery-'));
    delivery = join(scratch, 'delivery');
    mkdirSync(join(delivery, 'data', 'nested'), { recursive: true });
    mkdirSync(join(delivery, 'empty'));
    writeFileSync(join(delivery, 'x-Manifest.json'), MANIFEST);
    writeFileSync(join(delivery, 'data', 'part-00001.csv'), DATA);
    writeFileSync(join(delivery, 'data', 'nested', 'b.txt'), 'b');
    writeFileSync(join(scratch, 'outside.txt'), 'secret');
    symlinkSync(join(scratch, 'outside.txt'), join(delivery, 'link.txt'));
  });

  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('lists every entry sorted by path, with exact bytes for files and none for a link', async () => {
    const read = await new NodeDeliveryDirectory().read(delivery);
    assert.equal(read.ok, true);
    assert.deepEqual(read.value, [
      { path: 'data/nested/b.txt', bytes: new TextEncoder().encode('b') },
      { path: 'data/part-00001.csv', bytes: DATA },
      { path: 'link.txt' },
      { path: 'x-Manifest.json', bytes: MANIFEST },
    ]);
  });

  it('fails with the errno code of a missing directory, as the memory fake does', async () => {
    const missing = join(scratch, 'missing');
    const real = await new NodeDeliveryDirectory().read(missing);
    const fake = await new MemoryDeliveryDirectory().read(missing);
    assert.equal(real.ok, false);
    assert.equal(fake.ok, false);
    assert.equal(real.error.code, 'ENOENT');
    assert.equal(fake.error.code, real.error.code);
  });

  it('answers what the memory fake answers when placed with the same entries', async () => {
    const real = await new NodeDeliveryDirectory().read(delivery);
    assert.equal(real.ok, true);
    const fake = new MemoryDeliveryDirectory().place(delivery, [...real.value].reverse());
    assert.deepEqual(await fake.read(delivery), real);
  });

  it('fails on a file given as the directory', async () => {
    const read = await new NodeDeliveryDirectory().read(join(delivery, 'x-Manifest.json'));
    assert.equal(read.ok, false);
    assert.equal(read.error.code, 'ENOTDIR');
  });
});
