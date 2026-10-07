// The process's clocks, identities, timers and structured log (design §5.3 `ExecutionServices`):
// wall time, the monotonic `hrtime` clock (never serialized, BR-RUA-033), UUIDv4 identities, a
// `setTimeout` scheduler and sleeper, and one JSON line per runner log entry on stderr (stdout
// carries only the `cli_result` line).

import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import type { ExecutionLogLine, ExecutionServices } from '../../execution-lifecycle/execution-ports.ts';
import type { TimerHandle, TimerScheduler, Uuid4 } from '../../record-contract/primitives.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';

/**
 * The services every runner component shares, bound to this process.
 *
 * @example
 * const services = processServices(createRecordValidator());
 */
export function processServices(validator: RecordValidator): ExecutionServices {
  return {
    clock: { now: (): Date => new Date() },
    monotonic: { nowNs: (): bigint => process.hrtime.bigint() },
    sleeper: { sleep: (ms: number): Promise<void> => delay(ms) },
    ids: { next: (): Uuid4 => randomUUID() as Uuid4 },
    validator,
    log: (line: ExecutionLogLine): void => {
      process.stderr.write(`${JSON.stringify(line)}\n`);
    },
  };
}

/**
 * Timers on the process's event loop.
 *
 * @example
 * processScheduler().schedule(30_000, () => heartbeat()).cancel();
 */
export function processScheduler(): TimerScheduler {
  return {
    schedule: (delayMs: number, callback: () => void): TimerHandle => {
      const handle = setTimeout(callback, delayMs);
      return {
        cancel: (): void => {
          clearTimeout(handle);
        },
      };
    },
  };
}
