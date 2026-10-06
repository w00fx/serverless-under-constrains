// Offline stand-in for the telemetry locator (design §5.3 `TelemetryProbe`, BR-RUA-037): every
// signal of a trial is available under the design §9.7 names. It is the last read of a T8
// collection, so it also carries the offline cloud's collection hook.
//
// Test hook: `onNextCollection(action)` runs `action` once, at the next collection's telemetry
// read: after the collector has read everything else and before the pre-freeze recheck, which is
// where D-32 says activity can still appear (AC-RUA-020 `activity-at-pre-freeze-recheck`).

import type { CaptureScope } from '../../../src/evidence-collection/capture-scope.ts';
import type { CollectorReadFailure } from '../../../src/evidence-collection/collected-records.ts';
import type { TelemetryProbe, TelemetrySignal } from '../../../src/evidence-collection/telemetry-availability.ts';
import { ok } from '../../../src/record-contract/primitives.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';

export class OfflineTelemetryProbe implements TelemetryProbe {
  readonly #resourcePrefix: string;
  #pending: (() => void) | undefined;
  #collections = 0;

  /** `resourcePrefix` is the `<p>` of the execution's resource names (design §9.7). */
  constructor(resourcePrefix: string) {
    this.#resourcePrefix = resourcePrefix;
  }

  locate(signal: TelemetrySignal, _scope: CaptureScope): Promise<Result<readonly string[], CollectorReadFailure>> {
    if (signal === 'logs') {
      this.#collections += 1;
      const action = this.#pending;
      this.#pending = undefined;
      action?.();
    }
    return Promise.resolve(ok([`suc1-${this.#resourcePrefix}/${signal}`]));
  }

  /** Runs `action` once, during the next collection. */
  onNextCollection(action: () => void): void {
    this.#pending = action;
  }

  /** How many collections read telemetry. */
  collectionCount(): number {
    return this.#collections;
  }
}
