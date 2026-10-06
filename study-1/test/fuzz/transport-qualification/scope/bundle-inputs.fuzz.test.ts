// classifyBundleInputs partitions every bundler input exactly once (BR-RUA-028; testing rule 6).
// The example cases are in test/unit/transport-qualification/scope/bundle-inputs.test.ts; the property lives here so
// `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  classifyBundleInputs,
  packageInstallPath,
  sortedCodeUnits,
} from '../../../../src/transport-qualification/scope/bundle-inputs.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';

describe('classifyBundleInputs', () => {
  it('partitions every input exactly once (property)', () => {
    const segment = fc.constantFrom('node_modules', '@s', 'pkg', 'lib', 'src', 'x.js', 'a.ts');
    const path = fc.array(segment, { minLength: 1, maxLength: 6 }).map((segments) => segments.join('/'));
    fc.assert(
      fc.property(fc.array(path, { maxLength: 12 }), (paths) => {
        const classified = classifyBundleInputs('entry.ts', paths);
        const local = new Set(paths.filter((p) => packageInstallPath(p) === undefined));
        assert.deepEqual(classified.local_sources, sortedCodeUnits(local));
        for (const installPath of classified.packages) {
          assert.ok(paths.some((p) => packageInstallPath(p) === installPath));
          assert.ok(paths.some((p) => p.startsWith(`${installPath}/`)));
        }
        assert.equal(new Set(classified.packages).size, classified.packages.length);
      }),
      fuzzParameters(),
    );
  });
});
