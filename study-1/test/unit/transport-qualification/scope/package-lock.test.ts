// The lockfile read model behind "resolved dependency versions" (BR-RUA-028). The parser
// reads untrusted bytes, so a property test checks it is total and faithful.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { installDirectoryName, parsePackageLock } from '../../../../src/transport-qualification/scope/package-lock.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';

const encoder = new TextEncoder();

function lockBytes(document: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(document));
}

describe('parsePackageLock', () => {
  it('reads every installed package keyed by install path, without the root entry', () => {
    const parsed = parsePackageLock(
      lockBytes({
        lockfileVersion: 3,
        packages: {
          '': { name: 'study', version: '0.0.0' },
          'node_modules/esbuild': {
            version: '0.28.2',
            resolved: 'https://r/esbuild.tgz',
            integrity: 'sha512-x',
            dev: true,
          },
          'node_modules/a/node_modules/@s/b': { version: '1.0.0' },
          'node_modules/alias': { name: 'real-name', version: '2.0.0', dev: false },
          'node_modules/linked': { link: true, resolved: 7 },
          'node_modules/not-an-object': 'x',
        },
      }),
    );
    assert.ok(parsed.ok);
    assert.equal(parsed.value.lockfile_version, 3);
    assert.deepEqual(
      [...parsed.value.packages.entries()],
      [
        [
          'node_modules/esbuild',
          {
            install_path: 'node_modules/esbuild',
            name: 'esbuild',
            version: '0.28.2',
            resolved: 'https://r/esbuild.tgz',
            integrity: 'sha512-x',
            dev: true,
          },
        ],
        [
          'node_modules/a/node_modules/@s/b',
          { install_path: 'node_modules/a/node_modules/@s/b', name: '@s/b', version: '1.0.0', dev: false },
        ],
        ['node_modules/alias', { install_path: 'node_modules/alias', name: 'real-name', version: '2.0.0', dev: false }],
        ['node_modules/linked', { install_path: 'node_modules/linked', name: 'linked', dev: false }],
      ],
    );
  });

  it('accepts lockfile version 2', () => {
    const parsed = parsePackageLock(lockBytes({ lockfileVersion: 2, packages: {} }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.lockfile_version, 2);
    assert.equal(parsed.value.packages.size, 0);
  });

  it('refuses bytes that are not JSON, a non-object document, an unsupported version or missing packages', () => {
    const cases: readonly (readonly [Uint8Array, string])[] = [
      [Uint8Array.from([0xff]), 'package-lock.json is not one JSON document (invalid_utf8)'],
      [encoder.encode('{'), 'package-lock.json is not one JSON document (invalid_json)'],
      [lockBytes([1]), 'package-lock.json is array [1]; expected a JSON object'],
      [lockBytes({ packages: {} }), 'package-lock.json has lockfileVersion absent; expected 2 or 3'],
      [
        lockBytes({ lockfileVersion: 1, packages: {} }),
        'package-lock.json has lockfileVersion number 1; expected 2 or 3',
      ],
      [
        lockBytes({ lockfileVersion: '3', packages: {} }),
        'package-lock.json has lockfileVersion string "3"; expected 2 or 3',
      ],
      [lockBytes({ lockfileVersion: 3 }), 'package-lock.json has packages absent; expected a JSON object'],
      [
        lockBytes({ lockfileVersion: 3, packages: [] }),
        'package-lock.json has packages array []; expected a JSON object',
      ],
    ];
    for (const [bytes, detail] of cases) {
      assert.deepEqual(parsePackageLock(bytes), {
        ok: false,
        error: { code: 'LOCKFILE_INVALID', subject: 'BR-RUA-028', detail },
      });
    }
  });

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

describe('installDirectoryName', () => {
  it('takes the path after the last node_modules segment', () => {
    assert.equal(installDirectoryName('node_modules/a'), 'a');
    assert.equal(installDirectoryName('node_modules/@s/b'), '@s/b');
    assert.equal(installDirectoryName('node_modules/a/node_modules/@s/b'), '@s/b');
    assert.equal(installDirectoryName('packages/workspace'), 'packages/workspace');
  });
});
