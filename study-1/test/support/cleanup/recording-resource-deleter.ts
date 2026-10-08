// The offline direct deleter (design §12.2 `RecordingResourceDeleter`): deletes a resource from
// the `StubDiscoverySurfaces` account and records every request, so a test can prove which
// resources cleanup asked to delete (AC-RUA-011 "ambiguous ownership is never deleted").

import type { ResourceDeletion, ResourceDeleter } from '../../../src/cleanup/cleanup-ports.ts';
import type { DiscoveredResource } from '../../../src/cleanup/discovery.ts';
import { resourceKey } from '../../../src/cleanup/resource-names.ts';
import type { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';
import type { StubDiscoverySurfaces } from './stub-discovery-surfaces.ts';

/**
 * Deletes resources from a stub account and records each request.
 *
 * @example
 * const deleter = new RecordingResourceDeleter(surfaces, log);
 * await deleter.delete(table); // { kind: 'deleted' }, and the table is gone from every surface
 */
export class RecordingResourceDeleter implements ResourceDeleter {
  readonly #surfaces: StubDiscoverySurfaces;
  readonly #log: RecordingMutationLog;
  readonly #failing = new Set<string>();
  readonly #requests: DiscoveredResource[] = [];

  constructor(surfaces: StubDiscoverySurfaces, log: RecordingMutationLog) {
    this.#surfaces = surfaces;
    this.#log = log;
  }

  /** Every deletion of this identifier fails. */
  failFor(identifier: string): void {
    this.#failing.add(identifier);
  }

  /** The resources cleanup asked to delete, in call order. */
  requests(): readonly DiscoveredResource[] {
    return [...this.#requests];
  }

  delete(resource: DiscoveredResource): Promise<ResourceDeletion> {
    this.#requests.push(resource);
    this.#log.record({ port: 'resource-deleter', operation: 'Delete', target: resource.identifier });
    if (this.#failing.has(resource.identifier)) {
      return Promise.resolve({
        kind: 'failed',
        reason: {
          code: 'ResourceInUseException',
          subject: resource.identifier,
          detail: 'scripted deletion failure; expected the resource deleted',
        },
      });
    }
    const key = resourceKey(resource);
    if (!this.#surfaces.isPresent(key)) {
      return Promise.resolve({ kind: 'already_absent' });
    }
    this.#surfaces.remove(key);
    return Promise.resolve({ kind: 'deleted' });
  }
}
