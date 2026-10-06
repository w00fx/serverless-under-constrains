// A package's frozen execution manifest (BR-RUA-040) is read back byte for byte, judged by the
// lifecycle's total reader, and must name the execution its directory names.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS, executionIdOf } from '../../../src/evidence-package/package-layout.ts';
import { readPackageManifest } from '../../../src/operator-cli/package-manifest.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { MemoryPackageFileSystem } from '../../support/evidence-package/memory-package-file-system.ts';
import { utf8 } from '../../support/evidence-package/package-files.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';

const validator = createRecordValidator();
const run = offlineExecution('run');
const manifestBytes = run.core_files.get(EXECUTION_PATHS.executionManifest) ?? new Uint8Array();
const RUN_ID = executionIdOf(run.identity);
const OTHER_ID = '0b6d7a52-3c4e-4f80-9a1b-2c3d4e5f6a7b' as Uuid4;

async function filesWith(directory: string, bytes: Uint8Array): Promise<MemoryPackageFileSystem> {
  const files = new MemoryPackageFileSystem();
  const written = await files.writeOnce(`${directory}/${EXECUTION_PATHS.executionManifest}`, bytes);
  assert.equal(written.ok, true);
  return files;
}

describe('readPackageManifest', () => {
  it('reads the admitted execution of the package', async () => {
    const files = await filesWith(run.package_directory, manifestBytes);
    const admitted = await readPackageManifest(files, run.identity, validator);
    assert.equal(admitted.ok, true);
    assert.deepEqual(admitted.value.identity, run.identity);
    assert.equal(admitted.value.manifest_sha256, run.execution_manifest_sha256);
    assert.equal(admitted.value.package_directory, run.package_directory);
  });

  it('refuses a package with no manifest, naming the path and the read failure', async () => {
    const admitted = await readPackageManifest(new MemoryPackageFileSystem(), run.identity, validator);
    assert.equal(admitted.ok, false);
    assert.equal(admitted.error.code, 'EXECUTION_MANIFEST_UNREADABLE');
    assert.equal(admitted.error.subject, 'BR-RUA-040');
    assert.match(
      admitted.error.detail,
      new RegExp(
        `^${run.package_directory}/admission/execution-manifest\\.json: NOT_FOUND: .*; expected the package's frozen execution manifest$`,
      ),
    );
  });

  it("passes the reader's refusal of bytes that are not a manifest through", async () => {
    const files = await filesWith(run.package_directory, utf8('{"record_type":'));
    const admitted = await readPackageManifest(files, run.identity, validator);
    assert.equal(admitted.ok, false);
    assert.notEqual(admitted.error.code, 'EXECUTION_MANIFEST_UNREADABLE');
  });

  it('refuses a manifest of another execution', async () => {
    const elsewhere = { execution_kind: 'RUN', run_id: OTHER_ID } as const;
    const files = await filesWith(`runs/${OTHER_ID}`, manifestBytes);
    const admitted = await readPackageManifest(files, elsewhere, validator);
    assert.equal(admitted.ok, false);
    assert.equal(admitted.error.code, 'EXECUTION_MANIFEST_UNREADABLE');
    assert.match(admitted.error.detail, new RegExp(`declares RUN \\S+, not the package's RUN ${OTHER_ID}`));
  });

  it('refuses a manifest of another kind with the same id', async () => {
    const probeIdentity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: RUN_ID } as const;
    const files = await filesWith(`transport-probes/${RUN_ID}`, manifestBytes);
    const admitted = await readPackageManifest(files, probeIdentity, validator);
    assert.equal(admitted.ok, false);
    assert.match(admitted.error.detail, /not the package's TRANSPORT_PROBE /);
  });
});
