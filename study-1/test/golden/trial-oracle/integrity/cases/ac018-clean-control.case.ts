// AC-RUA-018 (BR-RUA-025): "Given a CONTROL trial, when treatment is never armed or consumed and
// every accepted call returns before its deadline, then control integrity is `verified`." The clean
// conventional CONTROL base: its configuration declares CONTROL, its partition holds no treatment
// item, no treatment event or targeted commit exists, and the one accepted call succeeded.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac018-clean-control',
  ac_ids: ['AC-RUA-018'],
  rule_outcomes_reached: [
    { rule_id: 'control_integrity', outcome: 'verified' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
  ],
  base: 'run-conventional-control',
  expected: {
    control_integrity: 'verified',
    gates: { control_integrity: 'verified', treatment_fidelity: 'not_applicable' },
    gate_reason_codes: { control_integrity: [] },
  },
});
