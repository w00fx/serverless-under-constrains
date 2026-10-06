// BR-RUA-029 matrix row 5: "Ledger unavailable or incomplete -> indeterminate, null". The
// conventional treatment trial without its ledger snapshot: ledger access is `unverified`, the
// monetary rules cannot conclude (design D-15), and the verdict is `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-05',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'ledger_access', outcome: 'unverified' },
    { rule_id: 'BR-RUA-001', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  operations: [{ op: 'delete_file', path: '$trial/ledger/ledger-snapshot.json' }],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { ledger_access: 'unverified' },
    rules: { 'BR-RUA-001': 'indeterminate', 'BR-RUA-002': 'indeterminate', 'BR-RUA-009': 'indeterminate' },
  },
});
