// Conformance of OfflineCoordinationCheckpointer to the CoordinationCheckpointWriter port (design
// §7, §10.2 P5; BR-RUA-044): the checkpoint it writes once is the production builder's checkpoint
// of the coordination journal's complete prefix, which the production checker accepts against the
// journal; an unreadable journal, a second write and a scripted refusal each report a reason and
// write nothing new.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import { checkPrefixCheckpoint } from '../../../../src/evidence-package/prefix-checkpoint.ts';
import type { CoordinationPrefixCheckpoint } from '../../../../src/record-contract/records/group-b/coordination_prefix_checkpoint.ts';
import { OfflineProbeCloud } from '../../../support/offline-cloud/offline-probe-cloud.ts';

const decoder = new TextDecoder();

function packageFile(cloud: OfflineProbeCloud, path: string): Uint8Array | undefined {
  return cloud.packageFiles().get(path);
}

describe('OfflineCoordinationCheckpointer conformance', () => {
  it('writes the checkpoint of the coordination journal prefix once', async () => {
    const cloud = new OfflineProbeCloud();
    await cloud.startExecution();
    assert.equal(await cloud.checkpoint.writeCheckpoint(), undefined);
    const bytes = packageFile(cloud, EXECUTION_PATHS.coordinationPrefixCheckpoint);
    const journal = packageFile(cloud, EXECUTION_PATHS.coordinationJournal);
    assert.ok(bytes !== undefined && journal !== undefined);
    const checkpoint = JSON.parse(decoder.decode(bytes)) as CoordinationPrefixCheckpoint;
    assert.equal(checkpoint.transport_probe_id, cloud.identity.transport_probe_id);
    assert.equal(checkpoint.prefix_byte_count, journal.length);
    assert.equal(checkPrefixCheckpoint(checkpoint, journal), undefined);
    const again = await cloud.checkpoint.writeCheckpoint();
    assert.equal(again?.code, 'COORDINATION_CHECKPOINT_NOT_WRITTEN');
    assert.deepEqual(packageFile(cloud, EXECUTION_PATHS.coordinationPrefixCheckpoint), bytes);
  });

  it('reports a coordination journal it cannot read', async () => {
    const cloud = new OfflineProbeCloud();
    const reason = await cloud.checkpoint.writeCheckpoint();
    assert.equal(reason?.code, 'COORDINATION_CHECKPOINT_NOT_WRITTEN');
    assert.match(reason.detail, /coordination journal is unreadable/u);
    assert.equal(packageFile(cloud, EXECUTION_PATHS.coordinationPrefixCheckpoint), undefined);
  });

  it('reports the builder reason for a journal with no complete event', async () => {
    const cloud = new OfflineProbeCloud();
    cloud.storage.seedRaw(`${cloud.package_directory}/${EXECUTION_PATHS.coordinationJournal}`, new Uint8Array());
    const reason = await cloud.checkpoint.writeCheckpoint();
    assert.ok(reason !== undefined);
    assert.equal(packageFile(cloud, EXECUTION_PATHS.coordinationPrefixCheckpoint), undefined);
  });

  it('refuses one scripted checkpoint, writing nothing', async () => {
    const cloud = new OfflineProbeCloud();
    await cloud.startExecution();
    const refusal = { code: 'COORDINATION_CHECKPOINT_NOT_WRITTEN', subject: 'BR-RUA-044', detail: 'scripted' };
    cloud.checkpoint.refuseNext(refusal);
    assert.deepEqual(await cloud.checkpoint.writeCheckpoint(), refusal);
    assert.equal(packageFile(cloud, EXECUTION_PATHS.coordinationPrefixCheckpoint), undefined);
    assert.equal(await cloud.checkpoint.writeCheckpoint(), undefined);
  });
});
