// Splitting the bundler's input list into project sources and lockfile install paths, the
// basis of the transitive production closure (BR-RUA-028). Includes a partition property.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import {
  classifyBundleInputs,
  compareCodeUnits,
  packageInstallPath,
  sortedCodeUnits,
} from '../../../../src/transport-qualification/scope/bundle-inputs.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';

describe('packageInstallPath', () => {
  it('returns the innermost package install path, scoped or not', () => {
    assert.equal(packageInstallPath('node_modules/esbuild/lib/main.js'), 'node_modules/esbuild');
    assert.equal(packageInstallPath('node_modules/@smithy/types/dist-es/index.js'), 'node_modules/@smithy/types');
    assert.equal(packageInstallPath('node_modules/a/node_modules/b/index.js'), 'node_modules/a/node_modules/b');
    assert.equal(
      packageInstallPath('node_modules/a/node_modules/@s/b/lib/deep/x.js'),
      'node_modules/a/node_modules/@s/b',
    );
    assert.equal(packageInstallPath('node_modules/pkg/index.js'), 'node_modules/pkg');
  });

  it('treats files outside node_modules, or without a package directory, as project files', () => {
    assert.equal(packageInstallPath('src/provider-client/arbiter.ts'), undefined);
    assert.equal(packageInstallPath('node_modules'), undefined);
    assert.equal(packageInstallPath('node_modules/loose.js'), undefined);
    assert.equal(packageInstallPath('node_modules/@scope/loose.js'), undefined);
    assert.equal(packageInstallPath('src/node_modules_like/x.ts'), undefined);
  });
});

describe('classifyBundleInputs', () => {
  it('splits, deduplicates and sorts project sources and packages', () => {
    assert.deepEqual(
      classifyBundleInputs('src/b.ts', [
        'src/b.ts',
        'node_modules/z/index.js',
        'src/a.ts',
        'node_modules/@s/y/lib/one.js',
        'node_modules/@s/y/lib/two.js',
        'node_modules/z/util.js',
      ]),
      {
        entry_point: 'src/b.ts',
        local_sources: ['src/a.ts', 'src/b.ts'],
        packages: ['node_modules/@s/y', 'node_modules/z'],
      },
    );
  });

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

describe('code-unit ordering', () => {
  it('orders by UTF-16 code units, uppercase before lowercase', () => {
    assert.deepEqual(sortedCodeUnits(['b', 'B', 'a', 'b']), ['B', 'a', 'b', 'b']);
    assert.equal(compareCodeUnits('a', 'a'), 0);
    assert.equal(compareCodeUnits('a', 'b'), -1);
    assert.equal(compareCodeUnits('b', 'a'), 1);
    assert.equal(compareCodeUnits('Z', 'a'), -1);
  });
});
