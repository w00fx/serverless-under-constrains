// StoredProbePackageReader (BR-RUA-028, design §8.16): the selected probe's original package and
// every amendment are read from the evidence file system; a failure to read either is returned as
// the port failure, never as an empty package.
//
// Boundary: the production reader over the memory package file system.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StoredProbePackageReader } from '../../../src/admission/stored-probe-package-reader.ts';
import { PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import { SteppingWallClock } from '../../support/deployment-assembly/deployment-fixtures.ts';
import { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { AdmissionHarness } from '../../support/admission/admission-harness.ts';
import { SELECTED_PROBE_ID } from '../../support/admission/selected-probe-package.ts';

const IDENTITY = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: SELECTED_PROBE_ID } as const;

async function storedProbe(): Promise<{ fs: MemoryPackageFileSystem; harness: AdmissionHarness }> {
  const harness = await AdmissionHarness.create('RUN');
  assert.ok(harness.selected !== undefined);
  const fs = new MemoryPackageFileSystem();
  for (const file of harness.selected.files) {
    const written = await fs.writeOnce(`${PACKAGE_LAYOUT.executionDirectory(IDENTITY)}/${file.path}`, file.bytes);
    assert.ok(written.ok);
  }
  return { fs, harness };
}

describe('StoredProbePackageReader', () => {
  it('reads the original package with no amendments', async () => {
    const { fs, harness } = await storedProbe();
    const read = await new StoredProbePackageReader(fs, new SteppingWallClock()).readProbePackage(harness.selection());
    assert.ok(read.ok);
    assert.deepEqual(read.value.amendments, []);
    assert.equal(read.value.selected_head, null);
    assert.deepEqual(read.value.identity, IDENTITY);
  });

  it('returns the failure when the original package cannot be listed', async () => {
    const { fs, harness } = await storedProbe();
    fs.failLists(PACKAGE_LAYOUT.executionDirectory(IDENTITY), 'IO_ERROR');
    const read = await new StoredProbePackageReader(fs, new SteppingWallClock()).readProbePackage(harness.selection());
    assert.ok(!read.ok);
    assert.equal(read.error.code, 'IO_ERROR');
  });

  it('returns the failure when the amendments cannot be listed', async () => {
    const { fs, harness } = await storedProbe();
    fs.failLists(PACKAGE_LAYOUT.amendmentsDirectory(IDENTITY), 'IO_ERROR');
    const read = await new StoredProbePackageReader(fs, new SteppingWallClock()).readProbePackage(harness.selection());
    assert.ok(!read.ok);
    assert.equal(read.error.code, 'IO_ERROR');
  });
});
