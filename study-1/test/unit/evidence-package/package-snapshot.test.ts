// Reading a stored package and its amendments through the file system port (MemoryPackageFileSystem,
// held to the local binding by the conformance suite): regular files as exact bytes, other entries
// kept aside, every top-level entry of the amendments directory one amendment, and a read failure
// returned rather than skipped.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readAmendmentSnapshots, readPackageSnapshot } from '../../../src/evidence-package/package-snapshot.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { at } from '../../support/record-contract/record-builders.ts';
import { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import {
  FIXTURE_DEPS,
  PROBE_IDENTITY,
  amendmentChain,
  billingPayload,
  probePackage,
} from '../../support/evidence-package/probe-package-fixtures.ts';

const PACKAGE_DIR = PACKAGE_LAYOUT.executionDirectory(PROBE_IDENTITY);
const AMENDMENTS_DIR = PACKAGE_LAYOUT.amendmentsDirectory(PROBE_IDENTITY);

async function stored(): Promise<{ readonly fs: MemoryPackageFileSystem; readonly head: Sha256Hex | null }> {
  const fs = new MemoryPackageFileSystem();
  const fixture = probePackage();
  for (const file of fixture.files) {
    await fs.writeOnce(`${PACKAGE_DIR}/${file.path}`, file.bytes);
  }
  const chain = amendmentChain(fixture, [
    { kind: 'BILLING', payload: [billingPayload()] },
    { kind: 'BILLING', payload: [billingPayload()] },
  ]);
  for (const amendment of chain) {
    for (const file of amendment.snapshot.files) {
      await fs.writeOnce(`${AMENDMENTS_DIR}/${amendment.snapshot.directory}/${file.path}`, file.bytes);
    }
  }
  return { fs, head: chain.at(-1)?.index_sha256 ?? null };
}

describe('readPackageSnapshot and readAmendmentSnapshots', () => {
  it('read back a stored package and chain that verify as eligible', async () => {
    const { fs, head } = await stored();
    const original = await readPackageSnapshot(fs, PROBE_IDENTITY);
    const amendments = await readAmendmentSnapshots(fs, PROBE_IDENTITY);
    assert.ok(original.ok && amendments.ok);
    assert.equal(amendments.value.length, 2);
    const verification = verifyPackage(
      {
        identity: PROBE_IDENTITY,
        original: original.value,
        amendments: amendments.value,
        selected_head: head,
        referenced_package_indexes: [],
        evaluated_at: at(1),
      },
      FIXTURE_DEPS,
    );
    assert.deepEqual(verification.package_ineligibility_reasons, []);
  });

  it('keeps symbolic links aside and turns a stray amendments entry into an amendment without index', async () => {
    const { fs } = await stored();
    fs.placeSpecial(`${PACKAGE_DIR}/probe/link`, 'symlink');
    await fs.writeOnce(`${AMENDMENTS_DIR}/stray.json`, utf8('{}'));
    const original = await readPackageSnapshot(fs, PROBE_IDENTITY);
    const amendments = await readAmendmentSnapshots(fs, PROBE_IDENTITY);
    assert.ok(original.ok && amendments.ok);
    assert.deepEqual(
      original.value.special_entries.map((entry) => entry.path),
      ['probe/link'],
    );
    assert.deepEqual(
      amendments.value.find((snapshot) => snapshot.directory === 'stray.json'),
      { directory: 'stray.json', files: [], special_entries: [] },
    );
  });

  it('reads no amendment when the amendments directory is absent', async () => {
    const fs = new MemoryPackageFileSystem();
    assert.deepEqual(await readAmendmentSnapshots(fs, PROBE_IDENTITY), { ok: true, value: [] });
    const original = await readPackageSnapshot(fs, PROBE_IDENTITY);
    assert.equal(original.ok ? 'ok' : original.error.code, 'NOT_FOUND');
  });

  it('returns a read failure instead of a partial snapshot', async () => {
    const { fs } = await stored();
    fs.failReads(`${PACKAGE_DIR}/package-index.json`, 'IO_ERROR');
    const original = await readPackageSnapshot(fs, PROBE_IDENTITY);
    assert.equal(original.ok ? 'ok' : original.error.code, 'IO_ERROR');
    const listed = await fs.list(AMENDMENTS_DIR);
    assert.ok(listed.ok);
    const firstIndex = listed.value.find((entry) => entry.path.endsWith('amendment-index.json'));
    assert.ok(firstIndex !== undefined);
    fs.failReads(`${AMENDMENTS_DIR}/${firstIndex.path}`, 'IO_ERROR');
    const amendments = await readAmendmentSnapshots(fs, PROBE_IDENTITY);
    assert.equal(amendments.ok ? 'ok' : amendments.error.code, 'IO_ERROR');
  });

  it('the port module is type-only: it loads and exports no runtime value (A-10)', async () => {
    const port: Readonly<Record<string, unknown>> =
      await import('../../../src/evidence-package/package-file-system.ts');
    assert.deepEqual(Object.keys(port), []);
  });

  it('returns a listing failure other than an absent directory', async () => {
    const { fs } = await stored();
    fs.failLists(AMENDMENTS_DIR, 'IO_ERROR');
    const amendments = await readAmendmentSnapshots(fs, PROBE_IDENTITY);
    assert.equal(amendments.ok ? 'ok' : amendments.error.code, 'IO_ERROR');
  });
});
