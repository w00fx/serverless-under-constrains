// Reading a package for verification and writing verifier outputs (design §7, §8.16): `--head`
// digests, every amendment found, the referenced probe index of a run's qualification, and file
// system failures as reasons naming the path.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import {
  parseDigest,
  parseDigestFlag,
  readVerificationInput,
  writeVerification,
} from '../../../src/operator-cli/package-reading.ts';
import { operandOf } from '../../../src/operator-cli/arg-parsing.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { HARNESS_NOW } from './support/cli-harness.ts';
import { storePackage } from './support/stored-packages.ts';

const validator = createRecordValidator();
const NOW = HARNESS_NOW as UtcMillis;
const run = offlineExecution('run');

describe('parseDigestFlag and parseDigest', () => {
  it('reads an absent flag as no head and a digest as itself', () => {
    assert.deepEqual(parseDigestFlag('head', undefined), { ok: true, value: null });
    assert.deepEqual(parseDigestFlag('head', 'a'.repeat(64)), { ok: true, value: 'a'.repeat(64) });
    assert.deepEqual(parseDigest('probe-index', 'b'.repeat(64)), { ok: true, value: 'b'.repeat(64) });
  });

  it('refuses anything else, quoting it', () => {
    for (const value of ['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}\n`]) {
      assert.deepEqual(parseDigestFlag('head', value), {
        ok: false,
        error: {
          code: 'USAGE_ERROR',
          subject: 'operator-cli',
          detail: `--head ${JSON.stringify(value)} is not a digest; expected 64 lowercase hexadecimal characters`,
        },
      });
    }
  });
});

describe('readVerificationInput', () => {
  it('reads the package, its amendments, the head and the qualification index it references', async () => {
    const fs = await storePackage(run.identity, run.core_files);
    const amendment = `${PACKAGE_LAYOUT.amendmentsDirectory(run.identity)}/0001-x/amendment-index.json`;
    assert.equal((await fs.writeOnce(amendment, utf8('{}'))).ok, true);
    const input = await readVerificationInput(fs, run.identity, 'c'.repeat(64) as never, NOW, validator);
    assert.equal(input.ok, true);
    assert.equal(input.value.original.files.length, run.core_files.size);
    assert.deepEqual(
      input.value.amendments.map((snapshot) => snapshot.directory),
      ['0001-x'],
    );
    assert.equal(input.value.selected_head, 'c'.repeat(64));
    assert.equal(input.value.evaluated_at, NOW);
    const manifest = JSON.parse(new TextDecoder().decode(run.core_files.get(EXECUTION_PATHS.executionManifest))) as {
      readonly qualification: { readonly original_package_index_sha256: string } | null;
    };
    assert.deepEqual(input.value.referenced_package_indexes, [manifest.qualification?.original_package_index_sha256]);
  });

  it('references nothing when the manifest is absent, unreadable or names no qualification', async () => {
    const absent = await storePackage(run.identity, [{ path: 'summary/x.json', bytes: utf8('{}') }]);
    const unreadable = await storePackage(run.identity, [
      { path: EXECUTION_PATHS.executionManifest, bytes: utf8('{') },
    ]);
    for (const fs of [absent, unreadable]) {
      const input = await readVerificationInput(fs, run.identity, null, NOW, validator);
      assert.deepEqual(input.ok && input.value.referenced_package_indexes, []);
    }
  });

  it('reports a package or an amendments directory it cannot list', async () => {
    const missing = await readVerificationInput(new MemoryPackageFileSystem(), run.identity, null, NOW, validator);
    assert.equal(missing.ok, false);
    assert.equal(missing.error.code, 'PACKAGE_UNREADABLE');
    assert.match(
      missing.error.detail,
      new RegExp(`^${run.package_directory}: NOT_FOUND: .*; expected a readable package directory$`),
    );
    const fs = await storePackage(run.identity, run.core_files);
    const amendments = PACKAGE_LAYOUT.amendmentsDirectory(run.identity);
    fs.failLists(amendments, 'IO_ERROR');
    const failed = await readVerificationInput(fs, run.identity, null, NOW, validator);
    assert.equal(failed.ok, false);
    assert.match(failed.error.detail, new RegExp(`^${amendments}: IO_ERROR: `));
  });
});

describe('writeVerification', () => {
  it('writes the record once below the evidence root and returns its path', async () => {
    const fs = new MemoryPackageFileSystem();
    const record = JSON.parse(new TextDecoder().decode(run.core_files.get(EXECUTION_PATHS.executionManifest))) as never;
    const path = PACKAGE_LAYOUT.verificationPath(run.identity, NOW, 'package-verification');
    assert.deepEqual(await writeVerification(fs, run.identity, NOW, 'package-verification', record), {
      ok: true,
      value: path,
    });
    const again = await writeVerification(fs, run.identity, NOW, 'package-verification', record);
    assert.equal(again.ok, false);
    assert.equal(again.error.code, 'VERIFICATION_NOT_WRITTEN');
    assert.match(again.error.detail, /: ALREADY_EXISTS: .*; expected a new verifier output below the evidence root$/);
  });
});

describe('operandOf', () => {
  it('gives the named operand, and nothing for a name the grammar lacks', () => {
    const args = { command: 'x', positionals: new Map([['package', 'p']]), flags: new Map(), evidence_root: 'e' };
    assert.equal(operandOf(args, 'package'), 'p');
    assert.equal(operandOf(args, 'trial-dir'), '');
  });
});
