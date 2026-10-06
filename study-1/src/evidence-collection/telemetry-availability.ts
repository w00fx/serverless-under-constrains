// Telemetry availability (design §7 `telemetry/telemetry-availability.json`, catalogue row 63;
// BR-RUA-037, AC-RUA-054). Logs, metrics and traces are diagnostic only: the oracle never reads
// them, and this record says only whether each signal could be located for the unit, with the
// locators found (log groups, metric names, trace ids) and the reasons a signal is unavailable.
// A probe that fails or finds nothing makes that one signal unavailable; it never fails the
// collection, because the absence of telemetry never blocks a verdict.

import { boundedText } from '../record-contract/json-value.ts';
import type { JsonObject, Result, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { TelemetryAvailability } from '../record-contract/records/group-b/vocabulary.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { correlationFields } from './capture-scope.ts';
import type { CaptureScope } from './capture-scope.ts';
import type { CollectorReadFailure } from './collected-records.ts';

/** The three diagnostic signals, in record order. */
export const TELEMETRY_SIGNALS = ['logs', 'metrics', 'traces'] as const;
export type TelemetrySignal = (typeof TELEMETRY_SIGNALS)[number];

/** Locates one signal of a unit: its non-empty locators, or why it could not look. */
export interface TelemetryProbe {
  locate(signal: TelemetrySignal, scope: CaptureScope): Promise<Result<readonly string[], CollectorReadFailure>>;
}

interface SignalRecord {
  readonly availability: TelemetryAvailability;
  readonly locators: readonly string[];
  readonly reasons: readonly StructuredReason[];
}

/**
 * Probes each signal and builds the `telemetry_availability` record of the unit.
 *
 * @example
 * const record = await captureTelemetryAvailability(probe, scope, clock);
 * record['logs']; // { availability: 'available', locators: ['/aws/lambda/…'], reasons: [] }
 */
export async function captureTelemetryAvailability(
  probe: TelemetryProbe,
  scope: CaptureScope,
  clock: WallClock,
): Promise<JsonObject> {
  const signals: Record<string, JsonObject> = {};
  for (const signal of TELEMETRY_SIGNALS) {
    signals[signal] = signalJson(signalAvailability(signal, await probe.locate(signal, scope)));
  }
  return {
    schema_version: 1,
    record_type: 'telemetry_availability',
    ...correlationFields(scope),
    captured_at: formatUtcMillis(clock.now()),
    ...signals,
  };
}

/**
 * The availability of one signal from its probe result: available with at least one non-empty
 * locator, otherwise unavailable with the reason.
 *
 * @example
 * signalAvailability('traces', { ok: true, value: [] }).availability; // 'unavailable'
 */
export function signalAvailability(
  signal: TelemetrySignal,
  located: Result<readonly string[], CollectorReadFailure>,
): SignalRecord {
  if (!located.ok) {
    return unavailable(
      'TELEMETRY_UNAVAILABLE',
      `${signal} could not be located: ${boundedText(located.error.code)}; expected a successful lookup`,
    );
  }
  const locators = located.value.filter((locator) => locator.length > 0);
  if (locators.length === 0) {
    return unavailable('TELEMETRY_NOT_FOUND', `${signal} lookup found no locator; expected at least one`);
  }
  return { availability: 'available', locators, reasons: [] };
}

function unavailable(code: string, detail: string): SignalRecord {
  return { availability: 'unavailable', locators: [], reasons: [{ code, subject: 'BR-RUA-037', detail }] };
}

function signalJson(signal: SignalRecord): JsonObject {
  return {
    availability: signal.availability,
    locators: [...signal.locators],
    reasons: signal.reasons.map((reason) => ({ ...reason })),
  };
}
