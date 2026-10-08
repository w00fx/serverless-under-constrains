// The offline discovery surfaces of the leak audit (design §12.2 `StubDiscoverySurfaces`): the
// AWS listing APIs as one in-memory account. Each placed sighting belongs to one surface; a
// resource is present while any non-tag-index sighting of it remains.
//
// Fault injection:
// - failQuery(surface, times): the next `times` queries of a surface fail (default: every one);
// - throwOnQuery(surface): every query of a surface throws, as a buggy adapter would;
// - lagAbsence(key, queries): after the resource is removed, each surface that listed it keeps
//   listing it for `queries` more queries (eventually consistent listings);
// - staleTagIndex(resource): the tag index lists a resource whose native describe says absent;
// - failPresence(identifier): the native describe of that identifier fails;
// - throwOnPresence(identifier): the native describe of that identifier throws.

import type {
  DiscoveredResource,
  DiscoverySurfaces,
  PresenceCheck,
  SurfaceQueryResult,
} from '../../../src/cleanup/discovery.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import type { LeakAuditSurface } from '../../../src/record-contract/records/group-c/vocabulary.ts';

interface LaggingSighting {
  readonly resource: DiscoveredResource;
  remaining: number;
}

/**
 * Discovery surfaces over an in-memory set of sightings, with scripted listing faults.
 *
 * @example
 * const surfaces = new StubDiscoverySurfaces();
 * surfaces.place(discovered(TABLE_RESOURCE_TYPE, 'suc1-aaaaaaaa-control', 'tables'));
 * await surfaces.query('tables'); // { ok: true, resources: [that table] }
 */
export class StubDiscoverySurfaces implements DiscoverySurfaces {
  #sightings: DiscoveredResource[] = [];
  #lagging: LaggingSighting[] = [];
  readonly #lagByKey = new Map<string, number>();
  readonly #failures = new Map<LeakAuditSurface, number>();
  readonly #throwing = new Set<LeakAuditSurface>();
  readonly #presenceFailures = new Set<string>();
  readonly #presenceThrows = new Set<string>();
  readonly #queries: LeakAuditSurface[] = [];

  /** Adds sightings; each is listed by its own surface. */
  place(...resources: readonly DiscoveredResource[]): void {
    this.#sightings.push(...resources);
  }

  /** Removes every sighting of the resource with this `resourceKey`; returns how many. */
  remove(key: string): number {
    const removed = this.#sightings.filter((sighting) => resourceKey(sighting) === key);
    this.#sightings = this.#sightings.filter((sighting) => resourceKey(sighting) !== key);
    const lag = this.#lagByKey.get(key) ?? 0;
    if (lag > 0) {
      this.#lagging.push(...removed.map((resource) => ({ resource, remaining: lag })));
    }
    return removed.length;
  }

  /** Whether a non-tag-index sighting of the resource remains. */
  isPresent(key: string): boolean {
    return this.#sightings.some((sighting) => sighting.surface !== 'tag_index' && resourceKey(sighting) === key);
  }

  /** The surfaces queried so far, in call order. */
  queries(): readonly LeakAuditSurface[] {
    return [...this.#queries];
  }

  failQuery(surface: LeakAuditSurface, times = Number.POSITIVE_INFINITY): void {
    this.#failures.set(surface, times);
  }

  throwOnQuery(surface: LeakAuditSurface): void {
    this.#throwing.add(surface);
  }

  lagAbsence(key: string, queries: number): void {
    this.#lagByKey.set(key, queries);
  }

  staleTagIndex(resource: DiscoveredResource): void {
    this.#sightings.push({ ...resource, surface: 'tag_index' });
  }

  failPresence(identifier: string): void {
    this.#presenceFailures.add(identifier);
  }

  throwOnPresence(identifier: string): void {
    this.#presenceThrows.add(identifier);
  }

  query(surface: LeakAuditSurface): Promise<SurfaceQueryResult> {
    this.#queries.push(surface);
    if (this.#throwing.has(surface)) {
      return Promise.reject(new Error(`scripted ${surface} adapter fault`));
    }
    const failures = this.#failures.get(surface) ?? 0;
    if (failures > 0) {
      this.#failures.set(surface, failures - 1);
      return Promise.resolve({
        ok: false,
        reason: {
          code: 'ThrottlingException',
          subject: surface,
          detail: `scripted ${surface} failure; expected a listing`,
        },
      });
    }
    return Promise.resolve({ ok: true, resources: [...this.#listed(surface), ...this.#lagged(surface)] });
  }

  confirmPresence(resource: DiscoveredResource): Promise<PresenceCheck> {
    if (this.#presenceThrows.has(resource.identifier)) {
      return Promise.reject(new Error(`scripted describe fault for ${resource.identifier}`));
    }
    if (this.#presenceFailures.has(resource.identifier)) {
      return Promise.resolve({
        kind: 'failed',
        reason: {
          code: 'AccessDenied',
          subject: resource.identifier,
          detail: 'scripted describe failure; expected a description',
        },
      });
    }
    return Promise.resolve({ kind: this.isPresent(resourceKey(resource)) ? 'present' : 'absent' });
  }

  #listed(surface: LeakAuditSurface): DiscoveredResource[] {
    return this.#sightings.filter((sighting) => sighting.surface === surface);
  }

  #lagged(surface: LeakAuditSurface): DiscoveredResource[] {
    const due = this.#lagging.filter((entry) => entry.resource.surface === surface);
    for (const entry of due) {
      entry.remaining -= 1;
    }
    this.#lagging = this.#lagging.filter((entry) => entry.remaining > 0);
    return due.map((entry) => entry.resource);
  }
}
