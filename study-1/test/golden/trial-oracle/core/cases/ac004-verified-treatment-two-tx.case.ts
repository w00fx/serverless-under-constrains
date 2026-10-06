// AC-RUA-004 (BR-RUA-001, -002, -006, -009), verified treatment: "a complete ledger snapshot with
// two successful full-refund transactions; BR-RUA-001, BR-RUA-002 and BR-RUA-009 fail; preservation
// is fail; the trial remains scientifically valid." The validation execution's Durable treatment
// trial follows the Expected Configured Trace: a targeted commit, a timeout and a committing retry,
// so the ledger refunds 20000 against the captured 10000.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac004-verified-treatment-two-tx',
  ac_ids: ['AC-RUA-004'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-002', outcome: 'fail' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'treatment_fidelity', outcome: 'verified' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'validation-durable-treatment',
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    treatment_fidelity: 'verified',
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 2, refunded_total_minor: '20000', ledger_complete: true },
  },
});
