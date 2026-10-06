// A package and its amendments on real disk (NodePackageFileSystem in a temporary directory): written
// once with the index last, read back through lstat listings, and verified. A byte changed on disk,
// a symbolic link planted in the package, or a second write of a frozen file are each caught
// (BR-RUA-043, BR-RUA-044, AC-RUA-022).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NodePackageFileSystem } from '../../../src/evidence-package/node/node-package-file-system.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { readAmendmentSnapshots, readPackageSnapshot } from '../../../src/evidence-package/package-snapshot.ts';
import { verifyPackage } from '../../../src/evidence-package/package-verifier.ts';
import type { PackageVerification } from '../../../src/record-contract/records/group-c/package_verification.ts';
import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import { at } from '../../support/record-contract/record-builders.ts';
import {
  FIXTURE_DEPS,
  PROBE_IDENTITY,
  amendmentChain,
  billingPayload,
  lateEvidencePayload,
  probePackage,
} from '../../support/evidence-package/probe-package-fixtures.ts';

const roots: string[] = [];
const PACKAGE_DIR = PACKAGE_LAYOUT.executionDirectory(PROBE_IDENTITY);
const AMENDMENTS_DIR = PACKAGE_LAYOUT.amendmentsDirectory(PROBE_IDENTITY);

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function writtenPackage(): Promise<{
  readonly root: string;
  readonly fs: NodePackageFileSystem;
  readonly head: Sha256Hex | null;
}> {
  const root = mkdtempSync(join(tmpdir(), 'rua-evidence-root-'));
  roots.push(root);
  const fs = new NodePackageFileSystem(root);
  const fixture = probePackage();
  for (const file of fixture.files) {
    assert.deepEqual(await fs.writeOnce(`${PACKAGE_DIR}/${file.path}`, file.bytes), { ok: true, value: undefined });
  }
  const chain = amendmentChain(fixture, [
    { kind: 'LATE_EVIDENCE', payload: [lateEvidencePayload(fixture, 'consistent')] },
    { kind: 'BILLING', payload: [billingPayload()] },
  ]);
  for (const amendment of chain) {
    for (const file of amendment.snapshot.files) {
      await fs.writeOnce(`${AMENDMENTS_DIR}/${amendment.snapshot.directory}/${file.path}`, file.bytes);
    }
  }
  return { root, fs, head: chain.at(-1)?.index_sha256 ?? null };
}

async function verifyOnDisk(fs: NodePackageFileSystem, head: Sha256Hex | null): Promise<PackageVerification> {
  const original = await readPackageSnapshot(fs, PROBE_IDENTITY);
  const amendments = await readAmendmentSnapshots(fs, PROBE_IDENTITY);
  assert.ok(original.ok && amendments.ok);
  return verifyPackage(
    {
      identity: PROBE_IDENTITY,
      original: original.value,
      amendments: amendments.value,
      selected_head: head,
      referenced_package_indexes: [],
      evaluated_at: at(30_000),
    },
    FIXTURE_DEPS,
  );
}

describe('evidence package on disk', () => {
  it('verifies a package and chain written once and read back as eligible', async () => {
    const { fs, head } = await writtenPackage();
    const verification = await verifyOnDisk(fs, head);
    assert.deepEqual(verification.package_ineligibility_reasons, []);
    assert.equal(verification.selected_chain.length, 2);
  });

  it('refuses a second write of a frozen file and keeps its bytes', async () => {
    const { root, fs } = await writtenPackage();
    const path = `${PACKAGE_DIR}/package-index.json`;
    const before = readFileSync(join(root, path));
    const second = await fs.writeOnce(path, new TextEncoder().encode('{}'));
    assert.equal(second.ok ? 'ok' : second.error.code, 'ALREADY_EXISTS');
    assert.deepEqual(readFileSync(join(root, path)), before);
  });

  it('is ineligible after one byte changes on disk', async () => {
    const { root, fs, head } = await writtenPackage();
    const path = join(root, PACKAGE_DIR, 'probe/ledger/ledger-snapshot.json');
    const bytes = readFileSync(path);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    writeFileSync(path, bytes);
    const verification = await verifyOnDisk(fs, head);
    assert.equal(verification.package_eligibility, 'ineligible');
    assert.ok(verification.package_ineligibility_reasons.some((reason) => reason.code === 'ALTERED_BYTES'));
  });

  it('is ineligible with a symbolic link planted in the package', async () => {
    const { root, fs, head } = await writtenPackage();
    symlinkSync('ledger/ledger-snapshot.json', join(root, PACKAGE_DIR, 'probe/alias.json'));
    const verification = await verifyOnDisk(fs, head);
    assert.deepEqual(
      verification.package_ineligibility_reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['UNINDEXED_FILE', 'probe/alias.json']],
    );
  });

  it('reports a package path that is not a directory as an I/O failure, not as an empty package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rua-evidence-root-'));
    roots.push(root);
    writeFileSync(join(root, 'transport-probes'), 'a file where the package root belongs');
    const original = await readPackageSnapshot(new NodePackageFileSystem(root), PROBE_IDENTITY);
    assert.equal(original.ok ? 'ok' : original.error.code, 'IO_ERROR');
    assert.match(original.ok ? '' : original.error.detail, /ENOTDIR/);
  });

  it('lists a FIFO as a special entry and never blocks reading it', async () => {
    const { root, fs, head } = await writtenPackage();
    execFileSync('mkfifo', [join(root, PACKAGE_DIR, 'probe/pipe')]);
    const read = await fs.read(`${PACKAGE_DIR}/probe/pipe`);
    assert.equal(typeof read.ok, 'boolean');
    const verification = await verifyOnDisk(fs, head);
    assert.deepEqual(
      verification.package_ineligibility_reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['UNINDEXED_FILE', 'probe/pipe']],
    );
  });
});
