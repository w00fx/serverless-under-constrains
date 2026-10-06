// The frozen execution manifest read back (design §10.1 A15; BR-RUA-040, BR-RUA-042; AC-RUA-008):
// the digest names the exact bytes, the identity and package come from the manifest, and bytes
// that are not one valid manifest are refused with a reason, never thrown (A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { identityOf, readAdmittedExecution } from '../../../src/execution-lifecycle/admitted-execution.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { ExecutionManifest } from '../../../src/record-contract/records/group-a/execution_manifest.ts';
import { offlineExecution } from '../../support/offline-cloud/offline-execution.ts';
import { lifecycleValidator } from '../../integration/execution-lifecycle/support/execution-fixtures.ts';

const PROBE_ID = '7d2e4f60-1a2b-4c3d-8e4f-5a6b7c8d9e0f' as Uuid4;

function manifestBytes(name: 'run' | 'validation-conventional'): Uint8Array {
  const bytes = offlineExecution(name).core_files.get(EXECUTION_PATHS.executionManifest);
  assert.ok(bytes !== undefined);
  return bytes;
}

describe('readAdmittedExecution', () => {
  it('reads a run with the digest of the exact bytes and its package directory', () => {
    const execution = offlineExecution('run');
    const bytes = manifestBytes('run');
    const admitted = readAdmittedExecution(bytes, lifecycleValidator());
    assert.equal(admitted.ok, true);
    assert.equal(admitted.value.manifest_sha256, sha256Hex(bytes));
    assert.equal(admitted.value.manifest_sha256, execution.execution_manifest_sha256);
    assert.deepEqual(admitted.value.identity, execution.identity);
    assert.equal(admitted.value.package_directory, execution.package_directory);
  });

  it('reads a variant validation into its own package directory', () => {
    const execution = offlineExecution('validation-conventional');
    const admitted = readAdmittedExecution(manifestBytes('validation-conventional'), lifecycleValidator());
    assert.equal(admitted.ok && admitted.value.package_directory, execution.package_directory);
    assert.match(execution.package_directory, /^variant-validations\//);
  });

  for (const [name, bytes] of [
    ['bytes that are not JSON', new TextEncoder().encode('{"schema_version":')],
    ['an empty file', new Uint8Array()],
    ['a record of another type', new TextEncoder().encode('{"schema_version":1,"record_type":"payment"}\n')],
  ] as const) {
    it(`refuses ${name} with a reason naming the manifest path`, () => {
      const admitted = readAdmittedExecution(bytes, lifecycleValidator());
      assert.equal(admitted.ok, false);
      assert.equal(admitted.error.artifact_path, EXECUTION_PATHS.executionManifest);
      assert.ok(admitted.error.detail.length > 0);
    });
  }

  it('refuses a manifest whose bytes were changed after the freeze', () => {
    const text = new TextDecoder().decode(manifestBytes('run'));
    const changed = new TextEncoder().encode(text.replace('"schema_version":1', '"schema_version":2'));
    assert.equal(readAdmittedExecution(changed, lifecycleValidator()).ok, false);
  });
});

describe('identityOf', () => {
  it('names the run, validation or probe the manifest declares', () => {
    const read = readAdmittedExecution(manifestBytes('run'), lifecycleValidator());
    assert.ok(read.ok);
    const manifest = read.value.manifest;
    assert.equal(identityOf(manifest).execution_kind, 'RUN');
    const validation = readAdmittedExecution(manifestBytes('validation-conventional'), lifecycleValidator());
    assert.ok(validation.ok);
    assert.equal(identityOf(validation.value.manifest).execution_kind, 'VARIANT_VALIDATION');
    const probe = {
      ...manifest,
      execution_kind: 'TRANSPORT_PROBE',
      transport_probe_id: PROBE_ID,
    } as unknown as ExecutionManifest;
    assert.deepEqual(identityOf(probe), { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID });
  });
});
