// P9 against the offline evidence root (design §7, §10.2; BR-RUA-043, BR-RUA-044): journals are
// made read-only before `package-index.json`, which is written last over the package exactly as
// finalized; a package the index cannot cover, an index that already exists and a run package the
// summary cannot read are reasons, never a partial index.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ExecutionPackage } from '../../../src/execution-lifecycle/execution-package.ts';
import { RunSummaryWriter, finalizePackage } from '../../../src/execution-lifecycle/execution-finalization.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { OfflinePackageStorage } from '../../support/offline-cloud/offline-package-storage.ts';
import { admittedOf, lifecycleValidator } from './support/execution-fixtures.ts';

const execution = offlineExecution('run');
const admitted = admittedOf(execution);
const AT = '2026-10-05T13:00:00.000Z' as UtcMillis;
const directory = admitted.package_directory;

async function admittedPackage(): Promise<{ storage: OfflinePackageStorage; pkg: ExecutionPackage }> {
  const storage = new OfflinePackageStorage();
  for (const [path, bytes] of execution.core_files) {
    await storage.writeOnce(`${directory}/${path}`, bytes);
  }
  return { storage, pkg: new ExecutionPackage(storage, admitted.identity, directory) };
}

describe('finalizePackage', () => {
  it('makes the present journals read-only and writes the index last, over the exact bytes', async () => {
    const { storage, pkg } = await admittedPackage();
    await storage.append(`${directory}/${EXECUTION_PATHS.runnerJournal}`, new TextEncoder().encode('{}\n'));
    const index = await finalizePackage(pkg, storage, admitted, AT);
    assert.ok(index.ok);
    const files = storage.filesUnder(directory);
    assert.equal(index.value, sha256Hex(files.get(EXECUTION_PATHS.packageIndex) ?? new Uint8Array()));
    const appended = await storage.append(`${directory}/${EXECUTION_PATHS.runnerJournal}`, new Uint8Array([0x0a]));
    assert.equal(appended.kind, 'not_written', 'the runner journal is read-only');
    assert.equal(files.get(EXECUTION_PATHS.cleanupJournal), undefined, 'an absent journal is not created');
  });

  it('writes no index over a file it cannot classify', async () => {
    const { storage, pkg } = await admittedPackage();
    await storage.writeOnce(`${directory}/stray/notes.bin`, new Uint8Array([1]));
    const index = await finalizePackage(pkg, storage, admitted, AT);
    assert.equal(index.ok, false);
    assert.equal(storage.filesUnder(directory).get(EXECUTION_PATHS.packageIndex), undefined);
  });

  it('reports an index that already exists', async () => {
    const { storage, pkg } = await admittedPackage();
    await storage.writeOnce(`${directory}/${EXECUTION_PATHS.packageIndex}`, new Uint8Array([0x7b]));
    const index = await finalizePackage(pkg, storage, admitted, AT);
    assert.deepEqual(!index.ok && index.error.map((reason) => reason.code), ['PACKAGE_FILE_NOT_WRITTEN']);
  });
});

describe('RunSummaryWriter', () => {
  it('reports a run package it cannot read, writing no summary', async () => {
    const { storage, pkg } = await admittedPackage();
    const reasons = await new RunSummaryWriter(lifecycleValidator()).write(pkg, admitted, AT);
    assert.ok(reasons.length > 0);
    assert.equal(storage.filesUnder(directory).get(EXECUTION_PATHS.runSummary), undefined);
  });
});
