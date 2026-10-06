// BR-RUA-029 matrix row 9: "Required journal or identity evidence missing -> indeterminate, null".
// The conventional treatment trial without its caller journal: the rule evidence BR-RUA-003 and
// -004 need is missing, so the trial is indeterminate even though the ledger shows two
// transactions.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-09',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'identity_integrity', outcome: 'unverified' },
    { rule_id: 'rule_evidence', outcome: 'unverified' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  operations: [{ op: 'delete_file', path: '$trial/journals/caller-journal.jsonl' }],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { identity_integrity: 'unverified', rule_evidence: 'unverified' },
    rules: { 'BR-RUA-003': 'indeterminate', 'BR-RUA-004': 'indeterminate' },
  },
});
