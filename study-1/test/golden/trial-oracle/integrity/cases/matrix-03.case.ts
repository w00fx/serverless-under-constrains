// BR-RUA-029 matrix row 3: "Verified treatment, two successful transactions -> fail, false". The
// canonical conventional COMMIT_THEN_TIMEOUT trial: the redelivered message refunds again, so the
// ledger holds two successful transactions and BR-RUA-001, -002 and -009 fail on a verified,
// valid trial.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-03',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'control_integrity', outcome: 'not_applicable' },
    { rule_id: 'treatment_fidelity', outcome: 'verified' },
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-002', outcome: 'fail' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-conventional-treatment',
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    gates: { control_integrity: 'not_applicable', treatment_fidelity: 'verified' },
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 2, refunded_total_minor: '20000', ledger_complete: true },
  },
});
