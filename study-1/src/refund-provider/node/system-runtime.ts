// Production bindings of the clock, identity and sleep ports for the provider function: the
// wall clock, `process.hrtime.bigint()` (monotonic, never serialized as an absolute value,
// BR-RUA-033; RF V4), `crypto.randomUUID()` (lowercase UUIDv4) and a timer-backed sleep.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleepFor } from 'node:timers/promises';

import type { MonotonicClock, Sleeper, Uuid4, UuidSource, WallClock } from '../../record-contract/primitives.ts';

export interface SystemRuntime {
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
  readonly ids: UuidSource;
  readonly sleeper: Sleeper;
}

/**
 * The process's clocks, identity source and sleeper.
 *
 * @example
 * const { wall, monotonic, ids, sleeper } = systemRuntime();
 */
export function systemRuntime(): SystemRuntime {
  return {
    wall: { now: () => new Date() },
    monotonic: { nowNs: () => process.hrtime.bigint() },
    ids: { next: () => randomUUID() as Uuid4 },
    sleeper: { sleep: (ms) => sleepFor(ms) },
  };
}
