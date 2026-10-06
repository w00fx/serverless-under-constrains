// AC-RUA-032 case: a safety release. The probe's single attempt commits and times out, but the
// provider releases the barrier through its safety deadline instead of an observed signal.
// Expected from BR-RUA-014 ('no safety release may occur'; any safety release is indeterminate,
// design §8.10) and BR-RUA-025 (a safety release makes fidelity unverified): the verdict is
// `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'safety-release',
  ac_ids: ['AC-RUA-032'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-014', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-027', outcome: 'indeterminate' },
  ],
  base: 'probe',
  plan: { deliveries: [{ attempts: [{ behavior: 'safety_release' }] }], processing: 'completes' },
  expected: {
    transport_probe_verdict: 'indeterminate',
    conditions: { 'BR-RUA-014': 'indeterminate' },
    treatment_fidelity: 'unverified',
  },
});
