// The in-memory payload of an amendment under construction (BR-RUA-043): write-once files, an
// append-only journal, and the files sorted by path for the amendment index.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AmendmentPayload } from '../../../src/execution-lifecycle/amendment-payload.ts';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('AmendmentPayload', () => {
  it('keeps each file written once and refuses a second write of the same path', async () => {
    const payload = new AmendmentPayload();
    assert.equal(await payload.writeOnce('payload/b.json', bytes('b')), undefined);
    const again = await payload.writeOnce('payload/b.json', bytes('other'));
    assert.equal(again?.code, 'PAYLOAD_FILE_EXISTS');
    assert.equal(again.artifact_path, 'payload/b.json');
    assert.deepEqual(payload.bytesAt('payload/b.json'), bytes('b'));
  });

  it('appends journal lines in order and finalizes without effect', async () => {
    const payload = new AmendmentPayload();
    assert.deepEqual(await payload.append('payload/j.jsonl', bytes('one\n')), { kind: 'appended' });
    await payload.append('payload/j.jsonl', bytes('two\n'));
    assert.deepEqual(await payload.finalize(), { kind: 'finalized' });
    assert.equal(new TextDecoder().decode(payload.bytesAt('payload/j.jsonl')), 'one\ntwo\n');
  });

  it('reads an unwritten path as an empty file', () => {
    assert.equal(new AmendmentPayload().bytesAt('payload/none').length, 0);
  });

  it('lists every file sorted by path', async () => {
    const payload = new AmendmentPayload();
    await payload.writeOnce('payload/z.json', bytes('z'));
    await payload.append('payload/a.jsonl', bytes('a'));
    await payload.writeOnce('payload/m.json', bytes('m'));
    assert.deepEqual(
      payload.files().map((file) => file.path),
      ['payload/a.jsonl', 'payload/m.json', 'payload/z.json'],
    );
  });
});
