// BR-RUA-029 matrix row 8: "Exact effect but processing active at deadline -> indeterminate,
// null". The treatment's first attempt commits the one authorized transaction, then the request
// never finishes: its message is still in flight at the 600 s deadline, so settlement is
// `unverified` (BR-RUA-032) and the verdict is `indeterminate` whatever the ledger shows.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-08',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'settlement', outcome: 'unverified' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  plan: { deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }], processing: 'active_at_deadline' },
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    processing_terminal_reason: null,
    gates: { settlement: 'unverified' },
    monetary_observations: { successful_transaction_count: 1, ledger_complete: true },
  },
});
