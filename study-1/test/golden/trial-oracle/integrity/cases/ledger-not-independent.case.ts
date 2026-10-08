// AC-RUA-055 rule coverage, `independent_oracle` invalid (BR-RUA-005): the CONTROL trial's ledger
// snapshot declares that the refund provider wrote it, not the evidence collector. A ledger the system
// under test wrote is not an independent oracle, so the gate is `invalid` and the trial invalid.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ledger-not-independent',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'independent_oracle', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [{ op: 'set', path: '$trial/ledger/ledger-snapshot.json', pointer: '/writer', value: 'refund_provider' }],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    gates: { independent_oracle: 'invalid' },
    gate_reason_codes: { independent_oracle: ['LEDGER_NOT_INDEPENDENT'] },
  },
});
