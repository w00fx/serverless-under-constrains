// Reads a trial execution report back as the tests of trial execution assert on it.

import assert from 'node:assert/strict';

import type { StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type { TrialExecutionReport } from '../../../../src/trial-execution/trial-execution-ports.ts';

/** The report of a trial that started and froze; fails the test otherwise. */
export type FrozenReport = Extract<TrialExecutionReport, { readonly kind: 'frozen' }>;

/** The reasons of a trial that never started; fails the test otherwise. */
export function notStartedReasons(report: TrialExecutionReport): readonly StructuredReason[] {
  assert.equal(report.kind, 'not_started', JSON.stringify(report));
  return report.reasons;
}

/** The report of a frozen trial; fails the test otherwise. */
export function frozenReport(report: TrialExecutionReport): FrozenReport {
  assert.equal(report.kind, 'frozen', JSON.stringify(report));
  return report;
}

/** The codes of some reasons, in order. */
export function codesOf(reasons: readonly StructuredReason[]): readonly string[] {
  return reasons.map((reason) => reason.code);
}
