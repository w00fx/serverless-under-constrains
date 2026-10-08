// BR-RUA-028 "transitive production dependency closure ... resolved dependency versions":
// bundled and declared packages resolve to exact locked versions, and the lockfile digest
// covers the closure's own entries only.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import {
  closureInstallPaths,
  resolveDependencyClosure,
} from '../../../../src/transport-qualification/scope/dependency-closure.ts';
import { SAMPLE_LOCK_ENTRIES, installedAsLocked, lockEntry, sampleLock } from './support/scope-fixtures.ts';

const TRANSPORT = 'node_modules/transport-dep';
const HELPER = 'node_modules/transport-dep/node_modules/@inner/helper';

function closureOf(
  bundled: readonly string[],
  declared: readonly string[],
  lock = sampleLock(),
  installed: ReadonlyMap<string, string> = installedAsLocked(lock),
): ReturnType<typeof resolveDependencyClosure> {
  return resolveDependencyClosure({
    bundled_packages: bundled,
    declared_dependencies: declared,
    lock,
    installed_versions: installed,
  });
}

describe('resolveDependencyClosure', () => {
  it('resolves bundled and declared packages to unique name and version pairs', () => {
    const closure = closureOf([TRANSPORT, HELPER, TRANSPORT], ['@scope/declared-dep', 'transport-dep']);
    assert.ok(closure.ok);
    assert.deepEqual(closure.value.dependencies, [
      { name: '@inner/helper', version: '2.0.0' },
      { name: '@scope/declared-dep', version: '4.1.0' },
      { name: 'transport-dep', version: '1.0.0' },
    ]);
  });

  it('digests the canonical version, tarball and integrity of the closure entries only', () => {
    const closure = closureOf([TRANSPORT], ['@scope/declared-dep']);
    assert.ok(closure.ok);
    const declared = SAMPLE_LOCK_ENTRIES['node_modules/@scope/declared-dep'];
    const transport = SAMPLE_LOCK_ENTRIES[TRANSPORT];
    const expected = canonicalJson({
      'node_modules/@scope/declared-dep': {
        version: '4.1.0',
        resolved: declared?.resolved ?? '',
        integrity: declared?.integrity ?? '',
      },
      [TRANSPORT]: { version: '1.0.0', resolved: transport?.resolved ?? '', integrity: transport?.integrity ?? '' },
    });
    assert.equal(closure.value.lockfile_sha256, sha256Hex(new TextEncoder().encode(expected)));
  });

  it('ignores lockfile changes outside the closure and catches a re-published tarball inside it', () => {
    const base = closureOf([TRANSPORT], []);
    const unrelated = closureOf(
      [TRANSPORT],
      [],
      sampleLock({ ...SAMPLE_LOCK_ENTRIES, 'node_modules/reporting-dep': lockEntry('reporting-dep', '8.0.0') }),
    );
    const republished = closureOf(
      [TRANSPORT],
      [],
      sampleLock({
        ...SAMPLE_LOCK_ENTRIES,
        [TRANSPORT]: lockEntry('transport-dep', '1.0.0', { integrity: 'sha512-other' }),
      }),
    );
    assert.ok(base.ok && unrelated.ok && republished.ok);
    assert.equal(unrelated.value.lockfile_sha256, base.value.lockfile_sha256);
    assert.notEqual(republished.value.lockfile_sha256, base.value.lockfile_sha256);
    assert.deepEqual(republished.value.dependencies, base.value.dependencies);
  });

  it('omits absent tarball and integrity fields from the digest', () => {
    const bare = closureOf([TRANSPORT], [], sampleLock({ [TRANSPORT]: { version: '1.0.0' } }));
    assert.ok(bare.ok);
    assert.equal(
      bare.value.lockfile_sha256,
      sha256Hex(new TextEncoder().encode(canonicalJson({ [TRANSPORT]: { version: '1.0.0' } }))),
    );
  });

  it('keeps two versions of one package as two entries ordered by version', () => {
    const lock = sampleLock({
      'node_modules/dup': lockEntry('dup', '2.0.0'),
      'node_modules/x/node_modules/dup': lockEntry('dup', '1.5.0'),
    });
    const closure = closureOf(['node_modules/dup', 'node_modules/x/node_modules/dup'], [], lock);
    assert.ok(closure.ok);
    assert.deepEqual(closure.value.dependencies, [
      { name: 'dup', version: '1.5.0' },
      { name: 'dup', version: '2.0.0' },
    ]);
  });

  it('refuses unlocked, versionless and development-only bundled packages, but accepts a declared dev tool', () => {
    const lock = sampleLock({ ...SAMPLE_LOCK_ENTRIES, 'node_modules/versionless': { resolved: 'x' } });
    assert.deepEqual(
      closureOf(['node_modules/dev-only', 'node_modules/ghost', 'node_modules/versionless'], ['missing-tool'], lock),
      {
        ok: false,
        error: [
          {
            code: 'BUNDLED_PACKAGE_NOT_PRODUCTION',
            subject: 'BR-RUA-028',
            detail:
              'bundled package node_modules/dev-only is marked dev in package-lock.json; expected a production dependency',
          },
          {
            code: 'DEPENDENCY_NOT_LOCKED',
            subject: 'BR-RUA-028',
            detail: 'node_modules/ghost is absent in package-lock.json; expected a locked entry with a version',
          },
          {
            code: 'DEPENDENCY_NOT_LOCKED',
            subject: 'BR-RUA-028',
            detail: 'node_modules/missing-tool is absent in package-lock.json; expected a locked entry with a version',
          },
          {
            code: 'DEPENDENCY_NOT_LOCKED',
            subject: 'BR-RUA-028',
            detail:
              'node_modules/versionless is present without a version in package-lock.json; expected a locked entry with a version',
          },
        ],
      },
    );
    const declaredDev = closureOf([], ['dev-only']);
    assert.ok(declaredDev.ok);
    assert.deepEqual(declaredDev.value.dependencies, [{ name: 'dev-only', version: '0.1.0' }]);
  });

  it('refuses a closure package installed at another version or not installed (regression: verify/spec-r1-stale-install.log)', () => {
    // The lockfile says 1.0.0 for transport-dep; node_modules still holds a stale 0.9.0, and the
    // declared package is missing, so the bundler would not run what the snapshot names.
    const installed = new Map([
      [TRANSPORT, '0.9.0'],
      [HELPER, '2.0.0'],
    ]);
    assert.deepEqual(closureOf([TRANSPORT, HELPER], ['@scope/declared-dep'], sampleLock(), installed), {
      ok: false,
      error: [
        {
          code: 'DEPENDENCY_INSTALL_MISMATCH',
          subject: 'BR-RUA-028',
          detail:
            'node_modules/@scope/declared-dep is not installed but package-lock.json locks 4.1.0; expected the locked ' +
            'version installed (npm ci at the admitted revision)',
        },
        {
          code: 'DEPENDENCY_INSTALL_MISMATCH',
          subject: 'BR-RUA-028',
          detail:
            'node_modules/transport-dep is installed at 0.9.0 but package-lock.json locks 1.0.0; expected the locked ' +
            'version installed (npm ci at the admitted revision)',
        },
      ],
    });
  });
});

describe('closureInstallPaths', () => {
  it('unites bundled install paths and declared names under node_modules, sorted and unique', () => {
    assert.deepEqual(closureInstallPaths([TRANSPORT, 'node_modules/esbuild'], ['esbuild', '@scope/declared-dep']), [
      'node_modules/@scope/declared-dep',
      'node_modules/esbuild',
      TRANSPORT,
    ]);
  });
});
