// Production bindings of the clock, identity and timer ports for the conventional caller
// function: the wall clock, `process.hrtime.bigint()` (monotonic, never serialized as an
// absolute value, BR-RUA-033), `crypto.randomUUID()` (lowercase UUIDv4) and a `setTimeout`
// scheduler for the provider client's deadline timer. Local to the feature: the conventional
// variant may not import the probe caller's runtime module (design §5.4 same-layer rule).

import { randomUUID } from 'node:crypto';

import type {
  MonotonicClock,
  TimerHandle,
  TimerScheduler,
  Uuid4,
  UuidSource,
  WallClock,
} from '../../record-contract/primitives.ts';

export interface ConventionalSystemRuntime {
  readonly wall: WallClock;
  readonly monotonic: MonotonicClock;
  readonly ids: UuidSource;
  readonly scheduler: TimerScheduler;
}

/**
 * The process's clocks, identity source and timer scheduler.
 *
 * @example
 * const { wall, monotonic, ids, scheduler } = conventionalSystemRuntime();
 */
export function conventionalSystemRuntime(): ConventionalSystemRuntime {
  return {
    wall: { now: () => new Date() },
    monotonic: { nowNs: () => process.hrtime.bigint() },
    ids: { next: () => randomUUID() as Uuid4 },
    scheduler: { schedule: scheduleTimeout },
  };
}

function scheduleTimeout(delayMs: number, callback: () => void): TimerHandle {
  const handle = setTimeout(callback, delayMs);
  return {
    cancel: (): void => {
      clearTimeout(handle);
    },
  };
}
