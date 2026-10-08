// Conformance of AliasingDigest: on every byte string it was not told about, it is the production
// digest (the kernel's SHA-256), so a verifier test that injects it differs from production only
// on the aliased amendment indexes.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import { AliasingDigest } from '../../../support/evidence-package/aliasing-digest.ts';
import { digest } from '../../../support/record-contract/record-builders.ts';

describe('AliasingDigest conforms to the production digest', () => {
  it('equals SHA-256 on byte strings that were not aliased', () => {
    const aliasing = new AliasingDigest();
    aliasing.alias(Uint8Array.of(1, 2, 3), digest('alias'));
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
        fc.pre(!(bytes.length === 3 && bytes[0] === 1 && bytes[1] === 2 && bytes[2] === 3));
        assert.equal(aliasing.digest(bytes), sha256Hex(bytes));
      }),
      { numRuns: 200 },
    );
  });

  it('returns the alias for exactly the aliased bytes, as a detached function', () => {
    const aliasing = new AliasingDigest();
    const { digest: hash } = aliasing;
    aliasing.alias(new TextEncoder().encode('index'), digest('loop'));
    assert.equal(hash(new TextEncoder().encode('index')), digest('loop'));
    assert.equal(hash(new TextEncoder().encode('index ')), sha256Hex(new TextEncoder().encode('index ')));
  });
});
