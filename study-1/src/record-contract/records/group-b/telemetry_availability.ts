// Catalogue group B row 63 (design §6.2): diagnostic availability of logs, metrics and
// traces; never an oracle input (BR-RUA-037, AC-RUA-054).

import type { StructuredReason, UtcMillis } from '../../primitives.ts';
import type { ExecutionCorrelation, ExecutionScoped, TrialScoped } from './shared-shapes.ts';
import type { TelemetryAvailability as Availability } from './vocabulary.ts';

/** Availability of one telemetry signal with its locators (log groups, metric names, trace ids). */
export interface SignalAvailability {
  readonly availability: Availability;
  readonly locators: readonly string[];
  readonly reasons: readonly StructuredReason[];
}

interface TelemetryAvailabilityFields {
  readonly schema_version: 1;
  readonly record_type: 'telemetry_availability';
  readonly captured_at: UtcMillis;
  readonly logs: SignalAvailability;
  readonly metrics: SignalAvailability;
  readonly traces: SignalAvailability;
}

/** Schema: `schemas/group-b/telemetry_availability.schema.json`. */
export type TelemetryAvailabilityRecord = ExecutionCorrelation &
  TelemetryAvailabilityFields &
  (TrialScoped | ExecutionScoped);
