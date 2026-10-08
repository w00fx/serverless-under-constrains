// Conformance of StubDiscoverySurfaces (design §12.2) to the DiscoverySurfaces contract: each
// surface lists exactly its own sightings, presence follows the native (non-tag-index)
// sightings, failures are values except the scripted throw, and each fault acts as documented.
//
// Sources (RK-17): [R-aws] §6.1, `GetResources` returns tagged or previously tagged resources, and
// whether it keeps listing deleted ones is unverified (so the stub can lag absence); [R-aws] §6.2,
// IAM roles and Lambda versions/aliases are not tag-discoverable; [R-aws] §6.3, the native
// listing APIs per surface.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resourceKey } from '../../../../src/cleanup/resource-names.ts';
import { FUNCTION_RESOURCE_TYPE, TABLE_RESOURCE_TYPE } from '../../../../src/cleanup/resource-types.ts';
import { discovered, NAMES } from '../../../support/cleanup/cleanup-fixtures.ts';
import { StubDiscoverySurfaces } from '../../../support/cleanup/stub-discovery-surfaces.ts';

const table = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');
const tableTagged = { ...table, surface: 'tag_index' as const };
const TABLE_KEY = resourceKey(table);

describe('StubDiscoverySurfaces conformance', () => {
  it('lists each sighting on its own surface and tracks presence by native sightings', async () => {
    const surfaces = new StubDiscoverySurfaces();
    surfaces.place(table, tableTagged);
    assert.deepEqual(await surfaces.query('tables'), { ok: true, resources: [table] });
    assert.deepEqual(await surfaces.query('tag_index'), { ok: true, resources: [tableTagged] });
    assert.deepEqual(await surfaces.query('functions'), { ok: true, resources: [] });
    assert.equal(surfaces.isPresent(TABLE_KEY), true);
    assert.deepEqual(await surfaces.confirmPresence(tableTagged), { kind: 'present' });
    assert.equal(surfaces.remove(TABLE_KEY), 2);
    assert.equal(surfaces.isPresent(TABLE_KEY), false);
    assert.deepEqual(await surfaces.confirmPresence(tableTagged), { kind: 'absent' });
    assert.deepEqual(surfaces.queries(), ['tables', 'tag_index', 'functions']);
  });

  it('fails a query the scripted number of times, then answers again', async () => {
    const surfaces = new StubDiscoverySurfaces();
    surfaces.failQuery('roles', 1);
    const failed = await surfaces.query('roles');
    assert.equal(failed.ok, false);
    assert.deepEqual(await surfaces.query('roles'), { ok: true, resources: [] });
    surfaces.failQuery('queues');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await surfaces.query('queues')).ok, false);
    }
  });

  it('keeps listing a removed resource for the lagging queries of each surface', async () => {
    const surfaces = new StubDiscoverySurfaces();
    surfaces.place(table, tableTagged);
    surfaces.lagAbsence(TABLE_KEY, 2);
    surfaces.remove(TABLE_KEY);
    assert.deepEqual(await surfaces.query('tables'), { ok: true, resources: [table] });
    assert.deepEqual(await surfaces.query('tables'), { ok: true, resources: [table] });
    assert.deepEqual(await surfaces.query('tables'), { ok: true, resources: [] });
    assert.deepEqual(await surfaces.query('tag_index'), { ok: true, resources: [tableTagged] });
    assert.equal(surfaces.isPresent(TABLE_KEY), false, 'a lagging listing is not presence');
  });

  it('lists a stale tag-index entry that the native describe reports absent', async () => {
    const surfaces = new StubDiscoverySurfaces();
    const fn = discovered(FUNCTION_RESOURCE_TYPE, NAMES.providerFunction, 'functions');
    surfaces.staleTagIndex(fn);
    assert.deepEqual(await surfaces.query('tag_index'), { ok: true, resources: [{ ...fn, surface: 'tag_index' }] });
    assert.deepEqual(await surfaces.query('functions'), { ok: true, resources: [] });
    assert.deepEqual(await surfaces.confirmPresence(fn), { kind: 'absent' });
  });

  it('fails or throws scripted describes and throws scripted queries', async () => {
    const surfaces = new StubDiscoverySurfaces();
    surfaces.place(table);
    surfaces.failPresence(NAMES.controlTable);
    assert.equal((await surfaces.confirmPresence(table)).kind, 'failed');
    surfaces.throwOnPresence('other');
    await assert.rejects(
      surfaces.confirmPresence({ ...table, identifier: 'other' }),
      /scripted describe fault for other/,
    );
    surfaces.throwOnQuery('stack');
    await assert.rejects(surfaces.query('stack'), /scripted stack adapter fault/);
  });
});
