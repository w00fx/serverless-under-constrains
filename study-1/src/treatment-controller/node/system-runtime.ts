// Production bindings of the clock and identity ports for the controller function: the wall
// clock and `crypto.randomUUID()` (lowercase UUIDv4). Local to the feature because the
// provider's runtime module is in a same-layer feature the controller may not import.

import { randomUUID } from 'node:crypto';

import type { Uuid4, UuidSource, WallClock } from '../../record-contract/primitives.ts';

export interface ControllerSystemRuntime {
  readonly wall: WallClock;
  readonly ids: UuidSource;
}

/**
 * The process's wall clock and identity source.
 *
 * @example
 * const { wall, ids } = controllerSystemRuntime();
 */
export function controllerSystemRuntime(): ControllerSystemRuntime {
  return {
    wall: { now: () => new Date() },
    ids: { next: () => randomUUID() as Uuid4 },
  };
}
