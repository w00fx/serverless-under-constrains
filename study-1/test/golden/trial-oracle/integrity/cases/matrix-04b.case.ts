// BR-RUA-029 matrix row 4, case b: "Invalid or unverified treatment with two observed transactions
// -> indeterminate with rule failures reported, null". The targeted commit is held but the
// controller never signals the caller's timeout, so the provider safety-releases it (OR-RUA-002);
// the redelivered message then refunds again. Without a signal the treatment path is not proven,
// so treatment fidelity is `unverified` and the trial indeterminate, while the conclusive ledger
// still reports the two transactions as rule failures (design D-15).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-04b',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'treatment_fidelity', outcome: 'unverified' },
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'safety_release' }] }, { attempts: [{ behavior: 'succeeded' }] }],
    processing: 'completes',
  },
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { treatment_fidelity: 'unverified' },
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 2, refunded_total_minor: '20000', ledger_complete: true },
  },
});
