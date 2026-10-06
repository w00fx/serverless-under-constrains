// BR-RUA-029 matrix row 10: "Proven duplicate with optional telemetry missing -> fail, false". The
// conventional treatment trial's two transactions prove the duplicate refund, and none of its
// logs, metrics or traces could be collected. Telemetry is diagnostic only (BR-RUA-037), so the
// verdict stands as it does with telemetry present.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const TELEMETRY = '$trial/telemetry/telemetry-availability.json';
const DETAIL = 'the signal could not be read when the trial was collected; expected it available';
const UNAVAILABLE = {
  availability: 'unavailable',
  locators: [],
  reasons: [{ code: 'TELEMETRY_UNAVAILABLE', subject: 'BR-RUA-037', detail: DETAIL }],
};

export default defineGoldenCase({
  case_id: 'matrix-10',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-conventional-treatment',
  operations: [
    { op: 'set', path: TELEMETRY, pointer: '/logs', value: UNAVAILABLE },
    { op: 'set', path: TELEMETRY, pointer: '/metrics', value: UNAVAILABLE },
    { op: 'set', path: TELEMETRY, pointer: '/traces', value: UNAVAILABLE },
  ],
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 2, refunded_total_minor: '20000', ledger_complete: true },
  },
});
