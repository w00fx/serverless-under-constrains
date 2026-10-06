// Shared fixtures of the telemetry binding tests (BR-RUA-037, AC-RUA-054): the binding of the
// collection fixtures' run (one durable and one conventional trial) and of a transport probe, with
// CloudFormation-style generated function names as a resource manifest records them.

import type { CaptureScope } from '../../../src/evidence-collection/capture-scope.ts';
import type { TelemetryBinding } from '../../../src/evidence-collection/telemetry-targets.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { DIGESTS, IDS } from '../../contract/record-contract/group-a/support/sample-values.ts';
import { RUN_ID, TRIAL_ID, TRIAL_SCOPE } from './collection-fixtures.ts';

export const CONVENTIONAL_TRIAL_ID = IDS.trial1;
export const PROBE_EXECUTION_ID = IDS.transportProbe;
/** 2026-10-05T12:05:00.000Z: the start of the durable trial and of the probe. */
export const UNIT_STARTED_MS = Date.UTC(2026, 9, 5, 12, 5);
/** 2026-10-05T12:20:00.000Z: the collection instant of the fixture clock. */
export const LOOKUP_MS = Date.UTC(2026, 9, 5, 12, 20);

export const FUNCTION_NAMES = {
  'conventional-caller': 'SucRua-run-00000000-ConventionalCallerFn1A2B3C',
  'durable-caller': 'SucRua-run-00000000-DurableCallerFn4D5E6F',
  'probe-caller': 'SucRua-probe-00000000-ProbeCallerFn7G8H9I',
  'refund-provider': 'SucRua-run-00000000-RefundProviderFnJ1K2L3',
  'treatment-controller': 'SucRua-run-00000000-TreatmentControllerFnM4N5',
} as const;

export const RUN_BINDING: TelemetryBinding = {
  execution_id: RUN_ID,
  function_names: FUNCTION_NAMES,
  trial_variants: new Map([
    [TRIAL_ID, 'durable'],
    [CONVENTIONAL_TRIAL_ID, 'conventional'],
  ]),
  unit_started_at: new Map([[TRIAL_ID, new Date(UNIT_STARTED_MS).toISOString() as UtcMillis]]),
};

export const PROBE_BINDING: TelemetryBinding = {
  execution_id: PROBE_EXECUTION_ID,
  function_names: FUNCTION_NAMES,
  trial_variants: new Map(),
  unit_started_at: new Map([['probe', new Date(UNIT_STARTED_MS).toISOString() as UtcMillis]]),
};

/** The durable trial of the run. */
export const DURABLE_TRIAL_SCOPE: CaptureScope = TRIAL_SCOPE;

/** The conventional trial of the run, which has not started yet in `RUN_BINDING`. */
export const CONVENTIONAL_TRIAL_SCOPE: CaptureScope = {
  ...TRIAL_SCOPE,
  unit: { kind: 'trial', trial_id: CONVENTIONAL_TRIAL_ID, trial_manifest_sha256: DIGESTS.trialManifest },
};

/** The probe unit of a transport-probe execution. */
export const PROBE_EXECUTION_SCOPE: CaptureScope = {
  execution: { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_EXECUTION_ID },
  execution_manifest_sha256: DIGESTS.executionManifest,
  unit: { kind: 'probe' },
};

/**
 * The run binding with the given unit start instants instead of the fixture ones.
 *
 * @example
 * bindingStartingAt({ [TRIAL_ID]: '2026-10-05T12:30:00.000Z' });
 */
export function bindingStartingAt(starts: Readonly<Record<string, string>>): TelemetryBinding {
  return { ...RUN_BINDING, unit_started_at: new Map(Object.entries(starts) as [string, UtcMillis][]) };
}

/**
 * A trial id the run binding does not declare.
 *
 * @example
 * telemetryUnit(RUN_BINDING, { ...TRIAL_SCOPE, unit: { ...TRIAL_SCOPE.unit, trial_id: UNDECLARED_TRIAL_ID } });
 */
export const UNDECLARED_TRIAL_ID = IDS.trial4;
