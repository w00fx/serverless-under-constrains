// A named fake of the collector's `TelemetryProbe` port (design §5.3, §12.2): each signal answers
// with its scripted locators or failure code; an unscripted signal finds nothing. A scripted
// rejection models a binding that throws instead of returning its failure (an SDK client called
// without `settleSdkCall`), which the collector must still record as unavailable (AC-RUA-054).

import type { Result } from '../../../src/record-contract/primitives.ts';
import type { CaptureScope } from '../../../src/evidence-collection/capture-scope.ts';
import type { CollectorReadFailure } from '../../../src/evidence-collection/collected-records.ts';
import type { TelemetryProbe, TelemetrySignal } from '../../../src/evidence-collection/telemetry-availability.ts';

/**
 * Scripted telemetry lookups, recording the scope each lookup was for.
 *
 * @example
 * const telemetry = new ScriptedTelemetryProbe({ logs: ['/aws/lambda/suc1-caller'] });
 * telemetry.scriptFailure('traces', 'ThrottlingException');
 */
export class ScriptedTelemetryProbe implements TelemetryProbe {
  readonly #locators = new Map<TelemetrySignal, readonly string[]>();
  readonly #failures = new Map<TelemetrySignal, string>();
  readonly #rejections = new Map<TelemetrySignal, Error>();
  readonly #lookups: { readonly signal: TelemetrySignal; readonly scope: CaptureScope }[] = [];

  constructor(locators: Partial<Readonly<Record<TelemetrySignal, readonly string[]>>> = {}) {
    for (const [signal, found] of Object.entries(locators) as [TelemetrySignal, readonly string[]][]) {
      this.#locators.set(signal, found);
    }
  }

  /** Every lookup of `signal` fails with `code`. */
  scriptFailure(signal: TelemetrySignal, code: string): void {
    this.#failures.set(signal, code);
  }

  /** Every lookup of `signal` rejects with `error`, as a binding that throws would. */
  scriptRejection(signal: TelemetrySignal, error: Error): void {
    this.#rejections.set(signal, error);
  }

  lookups(): readonly { readonly signal: TelemetrySignal; readonly scope: CaptureScope }[] {
    return [...this.#lookups];
  }

  locate(signal: TelemetrySignal, scope: CaptureScope): Promise<Result<readonly string[], CollectorReadFailure>> {
    this.#lookups.push({ signal, scope });
    const rejection = this.#rejections.get(signal);
    if (rejection !== undefined) {
      return Promise.reject(rejection);
    }
    const code = this.#failures.get(signal);
    if (code !== undefined) {
      return Promise.resolve({ ok: false, error: { code } });
    }
    return Promise.resolve({ ok: true, value: [...(this.#locators.get(signal) ?? [])] });
  }
}
