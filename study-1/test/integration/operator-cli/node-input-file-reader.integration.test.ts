// The local operator input reader over real temporary files, and the conformance of its named fake
// `MemoryInputFileReader`: both return a file's exact bytes and fail an absent path with `ENOENT`
// and a detail naming the path. The Node reader also keeps a directory's error code.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NodeInputFileReader } from '../../../src/operator-cli/node/node-input-file-reader.ts';
import { MemoryInputFileReader } from '../../unit/operator-cli/support/memory-input-file-reader.ts';

const scratch = mkdtempSync(join(tmpdir(), 'rua-input-reader-'));
const BYTES = new Uint8Array([0x7b, 0x7d, 0x0a, 0xff]);

describe('NodeInputFileReader', () => {
  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('reads exact bytes and fails an absent path as the memory reader does', async () => {
    const present = join(scratch, 'payment.json');
    const absent = join(scratch, 'absent.json');
    writeFileSync(present, BYTES);
    const node = new NodeInputFileReader();
    const memory = new MemoryInputFileReader().place(present, BYTES);
    assert.deepEqual(await node.readBytes(present), { ok: true, value: BYTES });
    assert.deepEqual(await memory.readBytes(present), await node.readBytes(present));
    const missing = await node.readBytes(absent);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'ENOENT');
    assert.ok(missing.error.detail.includes(absent));
    assert.deepEqual(await memory.readBytes(absent), missing);
  });

  it('keeps the error code of a path that is not a file', async () => {
    const read = await new NodeInputFileReader().readBytes(scratch);
    assert.equal(read.ok, false);
    assert.equal(read.error.code, 'EISDIR');
  });
});
