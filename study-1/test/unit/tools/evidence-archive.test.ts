// The public redacted copy as published (close-out): the plain files beside one ustar archive of
// every other file, written the same way every time: given order, mode 0644, owner 0:0, time 0,
// long paths split into prefix and name, and the archive padded to whole 20-block records.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publishedCopy, ustarArchive, ustarHeader } from '../../../tools/lib/evidence-archive.ts';
import { endOffset, readUstar } from './support/ustar-reader.ts';

const encoder = new TextEncoder();
const bytesOf = (text: string): Uint8Array => encoder.encode(text);
const RECORD = 10240;

describe('publishedCopy', () => {
  it('keeps the README, the manifest and the verdict recheck plain, and archives every other file', () => {
    const files = new Map([
      ['redaction-manifest.json', bytesOf('{}\n')],
      ['runs/x/package-index.json', bytesOf('{"entries":[]}')],
      ['verdict-recheck.json', bytesOf('[]\n')],
      ['verifications/x/a.json', bytesOf('{"a":1}')],
      ['README.md', bytesOf('# Copy\n')],
    ]);
    const published = publishedCopy(files);
    assert.deepEqual([...published.plain.keys()].sort(), [
      'README.md',
      'redaction-manifest.json',
      'verdict-recheck.json',
    ]);
    assert.deepEqual(published.plain.get('README.md'), bytesOf('# Copy\n'));
    assert.deepEqual(
      readUstar(published.tar).map((member) => [member.path, new TextDecoder().decode(member.content)]),
      [
        ['runs/x/package-index.json', '{"entries":[]}'],
        ['verifications/x/a.json', '{"a":1}'],
      ],
    );
  });
});

describe('ustarHeader', () => {
  it('writes every field of a regular file: mode 0644, owner 0:0 without names, time 0, no device numbers', () => {
    const [member] = readUstar(ustarArchive(new Map([['runs/x/a.json', bytesOf('hello')]])));
    assert.ok(member !== undefined);
    const { content, checksumValid, ...fields } = member;
    assert.deepEqual(fields, {
      path: 'runs/x/a.json',
      name: 'runs/x/a.json',
      prefix: '',
      mode: '0000644\0',
      uid: '0000000\0',
      gid: '0000000\0',
      size: '00000000005\0',
      mtime: '00000000000\0',
      // The checksum Python's tarfile writes for the same USTAR member.
      checksum: '010311\0 ',
      typeflag: '0',
      magic: 'ustar\0',
      version: '00',
      uname: '\0'.repeat(32),
      gname: '\0'.repeat(32),
      devmajor: '\0'.repeat(8),
      devminor: '\0'.repeat(8),
    });
    assert.equal(checksumValid, true);
    assert.deepEqual(content, bytesOf('hello'));
  });

  it('is one 512-byte block, zero outside its fields', () => {
    const header = ustarHeader('a', 0);
    assert.equal(header.length, 512);
    assert.ok(header.subarray(500).every((byte) => byte === 0));
    assert.ok(header.subarray(1, 100).every((byte) => byte === 0));
  });

  it('keeps a path of 100 bytes whole and splits a longer one at the first slash that leaves at most 100', () => {
    const whole = `runs/${'a'.repeat(95)}`;
    assert.deepEqual(readUstar(ustarArchive(new Map([[whole, new Uint8Array(0)]])))[0]?.prefix, '');
    const name = `${'n'.repeat(60)}/${'m'.repeat(39)}`;
    const long = `runs/${'p'.repeat(30)}/${name}`;
    const [member] = readUstar(ustarArchive(new Map([[long, new Uint8Array(0)]])));
    assert.deepEqual([member?.prefix, member?.name, member?.path], [`runs/${'p'.repeat(30)}`, name, long]);
    const edge = `${'p'.repeat(155)}/${'n'.repeat(100)}`;
    assert.deepEqual(
      [readUstar(ustarHeader(edge, 0))[0]?.prefix.length, readUstar(ustarHeader(edge, 0))[0]?.name.length],
      [155, 100],
    );
  });

  it('refuses a path that no slash splits into a prefix of at most 155 bytes and a name of at most 100', () => {
    for (const path of ['a'.repeat(101), `runs/${'n'.repeat(101)}`, `${'p'.repeat(156)}/${'n'.repeat(10)}`]) {
      assert.throws(() => ustarHeader(path, 0), {
        message: `${path} is ${String(path.length)} bytes; expected at most 100, or a slash after at most 155 bytes that leaves at most 100`,
      });
    }
  });

  it('writes the largest size the 11 octal digits hold and refuses a larger one', () => {
    assert.equal(readUstar(ustarHeader('big.bin', 8 ** 11 - 1))[0]?.size, '77777777777\0');
    assert.throws(() => ustarHeader('big.bin', 8 ** 11), {
      message: 'big.bin is 8589934592 bytes; expected at most 8589934591, the ustar size limit',
    });
  });
});

describe('ustarArchive', () => {
  it('writes the members in the order given, the same bytes for the same files in that order', () => {
    const entries: [string, Uint8Array][] = [
      ['runs/b/x.json', bytesOf('b')],
      ['runs/a/y.json', bytesOf('a')],
      ['README', bytesOf('r')],
    ];
    const archive = ustarArchive(new Map(entries));
    assert.deepEqual(
      readUstar(archive).map((member) => member.path),
      ['runs/b/x.json', 'runs/a/y.json', 'README'],
    );
    assert.deepEqual(ustarArchive(new Map(entries)), archive);
  });

  it('pads each file to whole blocks and ends with zero blocks to a whole 20-block record', () => {
    const archive = ustarArchive(
      new Map([
        ['a', new Uint8Array(512).fill(1)],
        ['b', new Uint8Array(513).fill(2)],
      ]),
    );
    assert.deepEqual(
      readUstar(archive).map((member) => member.content.length),
      [512, 513],
    );
    // a: header and one block; b: header and two blocks, the second holding one byte.
    assert.equal(endOffset(archive), 512 + 512 + 512 + 1024);
    assert.ok(archive.subarray(512 * 4 + 1, 512 * 5).every((byte) => byte === 0));
    assert.ok(archive.subarray(endOffset(archive)).every((byte) => byte === 0));
    assert.equal(archive.length, RECORD);
  });

  it('adds a record only when the end blocks do not fit in the last one', () => {
    const empties = (count: number): Map<string, Uint8Array> =>
      new Map(Array.from({ length: count }, (_, index) => [`f${String(index).padStart(2, '0')}`, new Uint8Array(0)]));
    assert.equal(ustarArchive(new Map()).length, RECORD);
    assert.ok(ustarArchive(new Map()).every((byte) => byte === 0));
    assert.equal(ustarArchive(empties(18)).length, RECORD);
    assert.equal(ustarArchive(empties(19)).length, 2 * RECORD);
    assert.equal(readUstar(ustarArchive(empties(19))).length, 19);
  });
});
