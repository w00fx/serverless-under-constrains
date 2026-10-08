// Property tests of the evidence archive writer (close-out, testing rule 6: it serializes every
// public evidence file). For any set of paths and contents, the archive reads back to exactly
// those files in the order given, with valid checksums and whole records, the same bytes every
// time; and it refuses a path exactly when no slash splits it into ustar's two name fields.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { ustarArchive } from '../../../tools/lib/evidence-archive.ts';
import { readUstar } from '../../unit/tools/support/ustar-reader.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const segment = fc.stringMatching(/^[\w.-]{1,70}$/);
const path = fc.array(segment, { minLength: 1, maxLength: 5 }).map((segments) => segments.join('/'));
const content = fc.uint8Array({ maxLength: 1100 });

// ustar holds a path whole in 100 bytes, or split at a slash into at most 155 + 100 bytes.
function fits(candidate: string): boolean {
  return (
    candidate.length <= 100 ||
    [...candidate.matchAll(/\//g)].some(({ index }) => index <= 155 && candidate.length - index - 1 <= 100)
  );
}

describe('ustarArchive over arbitrary files', () => {
  it('reads back to the same files in the order given, the same bytes every time', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(path.filter(fits), content), { selector: ([key]) => key, maxLength: 8 }),
        (entries) => {
          const archive = ustarArchive(new Map(entries));
          const members = readUstar(archive);
          assert.deepEqual(
            members.map((member) => [member.path, member.content]),
            entries,
          );
          assert.ok(members.every((member) => member.checksumValid));
          assert.equal(archive.length % 10240, 0);
          assert.deepEqual(ustarArchive(new Map(entries)), archive);
        },
      ),
      fuzzParameters(),
    );
  });

  it('refuses a path exactly when it does not fit the name fields', () => {
    fc.assert(
      fc.property(path, (candidate) => {
        const write = (): Uint8Array => ustarArchive(new Map([[candidate, new Uint8Array(0)]]));
        if (fits(candidate)) {
          assert.equal(readUstar(write())[0]?.path, candidate);
        } else {
          assert.throws(write, /; expected at most 100, or a slash after at most 155 bytes that leaves at most 100$/);
        }
      }),
      fuzzParameters(),
    );
  });
});
