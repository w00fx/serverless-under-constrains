// AC-RUA-029 case 3 (BR-RUA-006, BR-RUA-025): "an uncontrolled timeout" in a CONTROL trial. The
// provider commits slower than the caller's 3 s deadline; the controller rejects the timeout as a
// CONTROL trial's and the caller records `TIMED_OUT`; the redelivered message is then refunded
// again. A timeout in a control partition is proven, so control integrity is `invalid` and
// preservation `indeterminate` (BR-RUA-029), whatever the two transactions show.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'uncontrolled-timeout',
  ac_ids: ['AC-RUA-029'],
  rule_outcomes_reached: [
    { rule_id: 'control_integrity', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'untargeted_timeout' }] }, { attempts: [{ behavior: 'succeeded' }] }],
    processing: 'completes',
  },
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    control_integrity: 'invalid',
    gates: { control_integrity: 'invalid' },
    gate_reason_codes: { control_integrity: ['UNCONTROLLED_TIMEOUT'] },
  },
});
