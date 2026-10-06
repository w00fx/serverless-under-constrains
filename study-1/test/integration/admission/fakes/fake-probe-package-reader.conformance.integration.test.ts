// FakeProbePackageReader conformance (design §12.2): for a stored probe package, the production
// `StoredProbePackageReader` over the evidence file system holding the same files answers what
// the fake answers, and an unknown probe fails with NOT_FOUND in both.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { StoredProbePackageReader } from '../../../../src/admission/stored-probe-package-reader.ts';
import { PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { SteppingWallClock } from '../../../support/deployment-assembly/deployment-fixtures.ts';
import { MemoryPackageFileSystem } from '../../../support/evidence-package/memory-package-file-system.ts';
import { AdmissionHarness } from '../../../support/admission/admission-harness.ts';
import { FakeProbePackageReader } from '../../../support/admission/fake-probe-package-reader.ts';
import { SELECTED_PROBE_ID } from '../../../support/admission/selected-probe-package.ts';

const STARTED_AT = '2026-10-06T10:00:00.000Z';

describe('FakeProbePackageReader conforms to StoredProbePackageReader', () => {
  it('reads the same stored package for the same selection', async () => {
    const selected = (await AdmissionHarness.create('RUN')).selected;
    assert.ok(selected !== undefined);
    const fs = new MemoryPackageFileSystem();
    const directory = PACKAGE_LAYOUT.executionDirectory({
      execution_kind: 'TRANSPORT_PROBE',
      transport_probe_id: SELECTED_PROBE_ID,
    });
    for (const file of selected.files) {
      const written = await fs.writeOnce(`${directory}/${file.path}`, file.bytes);
      assert.ok(written.ok);
    }
    const fake = new FakeProbePackageReader(new SteppingWallClock(STARTED_AT));
    fake.store(SELECTED_PROBE_ID, selected.files);
    const real = await new StoredProbePackageReader(fs, new SteppingWallClock(STARTED_AT)).readProbePackage(
      selected.selection,
    );
    const scripted = await fake.readProbePackage(selected.selection);
    assert.ok(real.ok && scripted.ok);
    const byPath = (files: readonly { readonly path: string }[]): readonly string[] =>
      files.map((file) => file.path).sort();
    assert.deepEqual(byPath(scripted.value.original.files), byPath(real.value.original.files));
    assert.deepEqual({ ...scripted.value, original: undefined }, { ...real.value, original: undefined });
  });

  it('fails with NOT_FOUND for a probe that was never stored', async () => {
    const selection = {
      transport_probe_id: '6b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e' as Uuid4,
      original_package_index_sha256: 'ab'.repeat(32),
      amendment_head_sha256: null,
    } as const;
    const real = await new StoredProbePackageReader(
      new MemoryPackageFileSystem(),
      new SteppingWallClock(STARTED_AT),
    ).readProbePackage(selection as never);
    const scripted = await new FakeProbePackageReader(new SteppingWallClock(STARTED_AT)).readProbePackage(
      selection as never,
    );
    assert.ok(!real.ok && !scripted.ok);
    assert.equal(real.error.code, 'NOT_FOUND');
    assert.equal(scripted.error.code, 'NOT_FOUND');
  });
});
