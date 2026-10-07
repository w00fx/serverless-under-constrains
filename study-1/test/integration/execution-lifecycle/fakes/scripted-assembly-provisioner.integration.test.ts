// Conformance of the scripted assembly provisioner with the contract `FrozenAssemblyProvisioner`
// keeps: a frozen provisioning carries the manifest, the digest of its canonical bytes and its
// outputs; a refusal carries the reasons and no manifest; every subject is recorded.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { ProvisioningSubject } from '../../../../src/deployment-assembly/frozen-assembly-provisioner.ts';
import { resourceManifest } from '../../../support/cleanup/cleanup-fixtures.ts';
import { admittedOf } from '../support/execution-fixtures.ts';
import { offlineExecution } from '../../../support/offline-cloud/offline-execution.ts';
import { ScriptedAssemblyProvisioner } from './scripted-assembly-provisioner.ts';

const admitted = admittedOf(offlineExecution('run'));
const SUBJECT: ProvisioningSubject = {
  identity: admitted.identity,
  execution_manifest_sha256: admitted.manifest_sha256,
  deployment_assembly: admitted.manifest.deployment_assembly,
  package_directory: admitted.package_directory,
};

describe('ScriptedAssemblyProvisioner', () => {
  it('answers a frozen manifest with the digest of its canonical bytes, and records the subject', async () => {
    const manifest = resourceManifest();
    const assembly = new ScriptedAssemblyProvisioner({ kind: 'frozen', manifest });
    const frozen = await assembly.provision(SUBJECT);
    assert.ok(frozen.ok);
    assert.equal(frozen.value.resource_manifest_sha256, sha256Hex(serializeRecordFile(manifest)));
    assert.deepEqual(frozen.value.outputs, manifest.outputs);
    assert.deepEqual(frozen.value.reasons, []);
    assert.deepEqual(assembly.subjects(), [SUBJECT]);
  });

  it('answers the reasons no manifest was frozen', async () => {
    const reason = { code: 'DECLARED_TAGS_UNREADABLE', subject: 'BR-RUA-050', detail: 'scripted' };
    const refused = await new ScriptedAssemblyProvisioner({ kind: 'unfrozen', reasons: [reason] }).provision(SUBJECT);
    assert.deepEqual(refused, { ok: false, error: [reason] });
  });
});
