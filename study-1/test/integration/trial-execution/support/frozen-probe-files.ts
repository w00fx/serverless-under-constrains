// Reads a probe back from the offline probe cloud's evidence root and its report, as the tests of
// the probe workload assert on them.

import assert from 'node:assert/strict';

import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../../src/evidence-package/package-layout.ts';
import type { UNIT_PATHS } from '../../../../src/evidence-package/package-layout.ts';
import type { JsonObject, StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { ProbeExecutionReport } from '../../../../src/trial-execution/trial-execution-ports.ts';
import type { OfflineProbeCloud } from '../../../support/offline-cloud/offline-probe-cloud.ts';

const decoder = new TextDecoder();

/** The report of a frozen probe. */
export type FrozenProbeReport = Extract<ProbeExecutionReport, { readonly kind: 'frozen' }>;

/** The package path of one probe file. */
export function probePath(file: keyof typeof UNIT_PATHS): string {
  return PACKAGE_LAYOUT.unitFile({ kind: 'probe' }, file);
}

/** The single record of a JSON probe file; fails the test when the file is absent. */
export function probeRecord(cloud: OfflineProbeCloud, file: keyof typeof UNIT_PATHS): JsonObject {
  const bytes = cloud.packageFiles().get(probePath(file));
  assert.ok(bytes !== undefined, `${probePath(file)} is frozen`);
  return JSON.parse(decoder.decode(bytes)) as JsonObject;
}

/** Every runner event of the probe package, in journal order. */
export function probeRunnerEvents(cloud: OfflineProbeCloud): readonly JsonObject[] {
  const bytes = cloud.packageFiles().get(EXECUTION_PATHS.runnerJournal) ?? new Uint8Array();
  return decoder
    .decode(bytes)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject);
}

/** The reasons of a probe that never started; fails the test otherwise. */
export function probeNotStartedReasons(report: ProbeExecutionReport): readonly StructuredReason[] {
  assert.equal(report.kind, 'not_started', JSON.stringify(report));
  return report.reasons;
}

/** The report of a frozen probe; fails the test otherwise. */
export function frozenProbeReport(report: ProbeExecutionReport): FrozenProbeReport {
  assert.equal(report.kind, 'frozen', JSON.stringify(report));
  return report;
}
