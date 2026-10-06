// AC-RUA-029 case 2 (BR-RUA-006, BR-RUA-025): "treatment consumed" in a CONTROL trial. The
// provider's one commit is a targeted commit, the commit that consumes an armed treatment, which a
// CONTROL partition must never hold. Proven treatment consumption makes control integrity
// `invalid`, so the trial is invalid and preservation `indeterminate` (BR-RUA-029).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'treatment-consumed',
  ac_ids: ['AC-RUA-029'],
  rule_outcomes_reached: [
    { rule_id: 'control_integrity', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_transaction_committed' },
      pointer: '/targeted',
      value: true,
    },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    control_integrity: 'invalid',
    gates: { control_integrity: 'invalid' },
    gate_reason_codes: { control_integrity: ['TREATMENT_ACTIVITY'] },
  },
});
