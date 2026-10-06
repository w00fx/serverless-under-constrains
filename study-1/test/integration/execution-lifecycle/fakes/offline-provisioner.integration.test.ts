// Conformance of the offline provisioner with the P2 contract: one recorded deploy, the resource
// manifest left in the package with the digest of its exact bytes, targets only after a succeeded
// deploy, and a manifest that cannot be written reported instead of thrown.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';
import { offlineExecution } from '../../../support/offline-cloud/offline-execution.ts';
import { OfflinePackageStorage } from '../../../support/offline-cloud/offline-package-storage.ts';
import { admittedOf, targetsOf } from '../support/execution-fixtures.ts';
import { OfflineProvisioner } from './offline-provisioner.ts';

const execution = offlineExecution('run');
const bytes = execution.core_files.get(EXECUTION_PATHS.resourceManifest) ?? new Uint8Array();
const manifestPath = `${execution.package_directory}/${EXECUTION_PATHS.resourceManifest}`;

describe('OfflineProvisioner', () => {
  it('records one deploy, writes the manifest and answers the targets', async () => {
    const log = new RecordingMutationLog();
    const files = new OfflinePackageStorage();
    const provisioner = new OfflineProvisioner({ bytes, targets: targetsOf(execution), log, files });
    const outcome = await provisioner.provision(admittedOf(execution));
    assert.equal(provisioner.provisions(), 1);
    assert.deepEqual(
      log.entries().map((entry) => [entry.port, entry.operation, entry.target]),
      [['cloudformation', 'CreateStack', 'SucRua-run-b42ee7a8']],
    );
    assert.deepEqual(files.filesUnder(execution.package_directory).get(EXECUTION_PATHS.resourceManifest), bytes);
    assert.equal(outcome.resource_manifest_sha256, sha256Hex(bytes));
    assert.equal(outcome.resource_manifest_sha256, execution.resource_manifest_sha256);
    assert.equal(outcome.resource_manifest.provisioning_status, 'succeeded');
    assert.deepEqual(outcome.targets, targetsOf(execution));
    assert.deepEqual(outcome.reasons, []);
  });

  it('answers no targets and the scripted reasons for a failed deploy, without writing when told not to', async () => {
    const reason = { code: 'DEPLOY_FAILED', subject: 'BR-RUA-040', detail: 'CREATE_FAILED; expected CREATE_COMPLETE' };
    const seen: string[] = [];
    const log = new RecordingMutationLog();
    const outcome = await new OfflineProvisioner({
      bytes,
      reasons: [reason],
      log,
      during: (): void => {
        seen.push(`deploying after ${String(log.entries().length)} mutation(s)`);
      },
    }).provision(admittedOf(execution));
    assert.deepEqual(seen, ['deploying after 1 mutation(s)']);
    assert.equal(outcome.targets, undefined);
    assert.deepEqual(outcome.reasons, [reason]);
  });

  it('reports a manifest it could not write', async () => {
    const files = new OfflinePackageStorage();
    files.seedRaw(manifestPath, new Uint8Array([1]));
    const outcome = await new OfflineProvisioner({ bytes, log: new RecordingMutationLog(), files }).provision(
      admittedOf(execution),
    );
    assert.deepEqual(
      outcome.reasons.map((reason) => reason.code),
      ['RESOURCE_MANIFEST_NOT_WRITTEN'],
    );
  });
});
