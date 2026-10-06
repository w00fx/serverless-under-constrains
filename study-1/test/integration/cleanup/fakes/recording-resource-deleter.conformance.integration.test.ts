// Conformance of RecordingResourceDeleter (design §12.2) to the ResourceDeleter contract: a
// present resource is deleted from every surface, an absent one is already absent (idempotent
// deletion, AC-RUA-011), a scripted failure is a value, and every request is recorded and logged.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resourceKey } from '../../../../src/cleanup/resource-names.ts';
import { TABLE_RESOURCE_TYPE } from '../../../../src/cleanup/resource-types.ts';
import { discovered, NAMES } from '../../../support/cleanup/cleanup-fixtures.ts';
import { RecordingResourceDeleter } from '../../../support/cleanup/recording-resource-deleter.ts';
import { StubDiscoverySurfaces } from '../../../support/cleanup/stub-discovery-surfaces.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';

const table = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');

describe('RecordingResourceDeleter conformance', () => {
  it('deletes a present resource everywhere, then reports it already absent', async () => {
    const surfaces = new StubDiscoverySurfaces();
    surfaces.place(table, { ...table, surface: 'tag_index' });
    const log = new RecordingMutationLog();
    const deleter = new RecordingResourceDeleter(surfaces, log);
    assert.deepEqual(await deleter.delete(table), { kind: 'deleted' });
    assert.equal(surfaces.isPresent(resourceKey(table)), false);
    assert.deepEqual(await surfaces.query('tag_index'), { ok: true, resources: [] });
    assert.deepEqual(await deleter.delete(table), { kind: 'already_absent' });
    assert.deepEqual(deleter.requests(), [table, table]);
    assert.deepEqual(
      log.entries().map((entry) => entry.operation),
      ['Delete', 'Delete'],
    );
  });

  it('fails every deletion of a scripted identifier and leaves it in place', async () => {
    const surfaces = new StubDiscoverySurfaces();
    surfaces.place(table);
    const deleter = new RecordingResourceDeleter(surfaces, new RecordingMutationLog());
    deleter.failFor(NAMES.controlTable);
    const outcome = await deleter.delete(table);
    assert.equal(outcome.kind, 'failed');
    assert.equal(surfaces.isPresent(resourceKey(table)), true);
  });
});
