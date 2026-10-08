// One sweep over every discovery surface (BR-RUA-051, design §9.14), shared by the deletion of
// remaining owned resources (step 9) and each leak-audit pass (steps 10-11).
//
// The tag index is never trusted alone: a resource it lists is kept only when its native
// describe confirms it is present. One the native API reports absent is a stale index entry,
// not a leak. A describe that fails leaves the surface's answer unknown, so the surface counts
// as a failed query.

import type { StructuredReason } from '../record-contract/primitives.ts';
import type { LeakAuditSurface } from '../record-contract/records/group-c/vocabulary.ts';
import { LEAK_AUDIT_SURFACES } from '../record-contract/records/group-c/vocabulary.ts';
import type { DiscoveredResource, DiscoverySurfaces, PresenceCheck, SurfaceQueryResult } from './discovery.ts';
import { reasonFromThrown } from './thrown-reason.ts';

/** What one surface reported in one sweep. */
export interface SurfaceSighting {
  readonly surface: LeakAuditSurface;
  readonly query_ok: boolean;
  readonly resources: readonly DiscoveredResource[];
  readonly reasons: readonly StructuredReason[];
}

/**
 * Queries every surface once, in the catalogue order of `LEAK_AUDIT_SURFACES`. Never throws: a
 * query or describe that throws is a failed query.
 *
 * @example
 * const sightings = await sweepSurfaces(surfaces);
 * sightings.every((sighting) => sighting.query_ok); // true when discovery succeeded everywhere
 */
export async function sweepSurfaces(surfaces: DiscoverySurfaces): Promise<readonly SurfaceSighting[]> {
  const sightings: SurfaceSighting[] = [];
  for (const surface of LEAK_AUDIT_SURFACES) {
    sightings.push(await sightSurface(surfaces, surface));
  }
  return sightings;
}

async function sightSurface(surfaces: DiscoverySurfaces, surface: LeakAuditSurface): Promise<SurfaceSighting> {
  const answer = await queryTotally(surfaces, surface);
  if (!answer.ok) {
    return { surface, query_ok: false, resources: [], reasons: [answer.reason] };
  }
  if (surface !== 'tag_index') {
    return { surface, query_ok: true, resources: answer.resources, reasons: [] };
  }
  const present: DiscoveredResource[] = [];
  const reasons: StructuredReason[] = [];
  for (const resource of answer.resources) {
    const presence = await confirmTotally(surfaces, resource);
    if (presence.kind === 'failed') {
      reasons.push(presence.reason);
    }
    if (presence.kind === 'present') {
      present.push(resource);
    }
  }
  return { surface, query_ok: reasons.length === 0, resources: present, reasons };
}

async function queryTotally(surfaces: DiscoverySurfaces, surface: LeakAuditSurface): Promise<SurfaceQueryResult> {
  try {
    return await surfaces.query(surface);
  } catch (thrown: unknown) {
    return { ok: false, reason: reasonFromThrown(thrown, 'SURFACE_QUERY_THREW', surface) };
  }
}

async function confirmTotally(surfaces: DiscoverySurfaces, resource: DiscoveredResource): Promise<PresenceCheck> {
  try {
    return await surfaces.confirmPresence(resource);
  } catch (thrown: unknown) {
    return { kind: 'failed', reason: reasonFromThrown(thrown, 'PRESENCE_CHECK_THREW', resource.identifier) };
  }
}
