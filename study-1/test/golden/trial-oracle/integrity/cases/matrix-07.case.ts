// BR-RUA-029 matrix row 7: "Exact effect with terminal DLQ processing -> pass, false". The
// conventional treatment's redelivery fails its commit definitively, so the message exhausts its
// receives and lands in the DLQ; the ledger holds exactly the authorized transaction, so the verdict
// is `pass` and the non-successful terminal reason makes correct_completion false (BR-RUA-030).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-07',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
    { rule_id: 'BR-RUA-006', outcome: 'pass' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-conventional-treatment',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }, { attempts: [{ behavior: 'commit_failed' }] }],
    processing: 'completes',
  },
  expected: {
    preservation_verdict: 'pass',
    trial_validity: 'valid',
    processing_terminal_reason: 'RETRIES_EXHAUSTED',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'pass', 'BR-RUA-009': 'pass' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
