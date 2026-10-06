// One sweep over the BR-RUA-051 surfaces (design §9.14): every surface in catalogue order, a
// failed or throwing query recorded as a failed query, and tag-index entries kept only when the
// native describe confirms them.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TABLE_RESOURCE_TYPE, FUNCTION_RESOURCE_TYPE } from '../../../src/cleanup/resource-types.ts';
import { sweepSurfaces } from '../../../src/cleanup/surface-sweep.ts';
import { LEAK_AUDIT_SURFACES } from '../../../src/record-contract/records/group-c/vocabulary.ts';
import { discovered, NAMES } from '../../support/cleanup/cleanup-fixtures.ts';
import { StubDiscoverySurfaces } from '../../support/cleanup/stub-discovery-surfaces.ts';

describe('sweepSurfaces', () => {
  it('queries every surface once, in catalogue order', async () => {
    const surfaces = new StubDiscoverySurfaces();
    const table = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');
    surfaces.place(table);
    const sightings = await sweepSurfaces(surfaces);
    assert.deepEqual(surfaces.queries(), LEAK_AUDIT_SURFACES);
    assert.deepEqual(
      sightings.map((sighting) => sighting.surface),
      LEAK_AUDIT_SURFACES,
    );
    assert.deepEqual(sightings.find((sighting) => sighting.surface === 'tables')?.resources, [table]);
    assert.ok(sightings.every((sighting) => sighting.query_ok && sighting.reasons.length === 0));
  });

  it('records a failed query and a throwing query as failed queries', async () => {
    const surfaces = new StubDiscoverySurfaces();
    surfaces.failQuery('roles');
    surfaces.throwOnQuery('queues');
    const sightings = await sweepSurfaces(surfaces);
    const roles = sightings.find((sighting) => sighting.surface === 'roles');
    const queues = sightings.find((sighting) => sighting.surface === 'queues');
    assert.deepEqual(roles?.query_ok, false);
    assert.deepEqual(
      roles.reasons.map((reason) => reason.code),
      ['ThrottlingException'],
    );
    assert.deepEqual(queues?.query_ok, false);
    assert.deepEqual(queues.reasons, [
      {
        code: 'SURFACE_QUERY_THREW',
        subject: 'queues',
        detail: 'threw Error: scripted queues adapter fault; expected a result value',
      },
    ]);
  });

  it('keeps tag-index entries the native describe confirms and drops stale ones', async () => {
    const surfaces = new StubDiscoverySurfaces();
    const present = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');
    surfaces.place(present, { ...present, surface: 'tag_index' });
    surfaces.staleTagIndex(discovered(FUNCTION_RESOURCE_TYPE, NAMES.providerFunction, 'functions'));
    const [tagIndex] = await sweepSurfaces(surfaces);
    assert.deepEqual(tagIndex, {
      surface: 'tag_index',
      query_ok: true,
      resources: [{ ...present, surface: 'tag_index' }],
      reasons: [],
    });
  });

  it('fails the tag index when a describe fails or throws, keeping the other confirmations', async () => {
    const surfaces = new StubDiscoverySurfaces();
    const present = discovered(TABLE_RESOURCE_TYPE, NAMES.controlTable, 'tables');
    surfaces.place(present, { ...present, surface: 'tag_index' });
    surfaces.staleTagIndex(discovered(FUNCTION_RESOURCE_TYPE, 'f-failing', 'functions'));
    surfaces.staleTagIndex(discovered(FUNCTION_RESOURCE_TYPE, 'f-throwing', 'functions'));
    surfaces.failPresence('f-failing');
    surfaces.throwOnPresence('f-throwing');
    const [tagIndex] = await sweepSurfaces(surfaces);
    assert.equal(tagIndex?.query_ok, false);
    assert.deepEqual(
      tagIndex.resources.map((resource) => resource.identifier),
      [NAMES.controlTable],
    );
    assert.deepEqual(
      tagIndex.reasons.map((reason) => [reason.code, reason.subject]),
      [
        ['AccessDenied', 'f-failing'],
        ['PRESENCE_CHECK_THREW', 'f-throwing'],
      ],
    );
  });
});
