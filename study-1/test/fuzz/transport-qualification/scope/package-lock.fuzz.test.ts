// parsePackageLock is total over arbitrary bytes and faithful to generated lockfiles
// (BR-RUA-028; testing rule 6: a parser of untrusted bytes). The example cases are in test/unit/transport-qualification/scope/package-lock.test.ts; the property lives here so
// `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { parsePackageLock } from '../../../../src/transport-qualification/scope/package-lock.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { lockBytes } from '../../../unit/transport-qualification/scope/support/lockfile-bytes.ts';

describe('parsePackageLock', () => {
  it('is total over arbitrary bytes and faithful to generated lockfiles (property)', () => {
    const name = fc.stringMatching(/^(@[a-z]{1,3}\/)?[a-z]{1,6}$/);
    const entry = fc.record(
      { version: fc.string(), resolved: fc.string(), integrity: fc.string(), dev: fc.boolean() },
      { requiredKeys: [] },
    );
    const lockfile = fc.dictionary(
      name.map((n) => `node_modules/${n}`),
      entry,
      { maxKeys: 6 },
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 40 }),
          fc.jsonValue().map((v) => lockBytes(v)),
        ),
        (bytes) => {
          const parsed = parsePackageLock(bytes);
          assert.equal(typeof parsed.ok, 'boolean');
        },
      ),
      fuzzParameters(),
    );
    fc.assert(
      fc.property(lockfile, (packages) => {
        const parsed = parsePackageLock(lockBytes({ lockfileVersion: 3, packages }));
        assert.ok(parsed.ok);
        assert.deepEqual([...parsed.value.packages.keys()], Object.keys(packages));
        for (const [installPath, locked] of parsed.value.packages) {
          const source = packages[installPath];
          assert.equal(locked.version, source?.version);
          assert.equal(locked.dev, source?.dev === true);
          assert.equal(locked.name, installPath.slice('node_modules/'.length));
        }
      }),
      fuzzParameters(),
    );
  });
});
