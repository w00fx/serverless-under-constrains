// AC-RUA-055 rule coverage, `settlement` invalid (BR-RUA-032): the runner's settlement assessment
// says the treatment trial settled one second later than its frozen settlement samples re-derive.
// The oracle never trusts the runner's judgement over the samples, so the disagreement makes the
// settlement gate `invalid` and the trial invalid.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

/** The treatment trial's settlement assessment, as the builder derives it. */
const SETTLEMENT_ASSESSED = '6edaeda6-e240-4061-89d9-3bb785ed8d12';

export default defineGoldenCase({
  case_id: 'settlement-rederivation-mismatch',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'settlement', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  operations: [
    {
      op: 'set',
      path: 'runner/runner-journal.jsonl',
      select: { event_id: SETTLEMENT_ASSESSED },
      pointer: '/established_at',
      value: '2026-10-05T12:39:06.000Z',
    },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    gates: { settlement: 'invalid' },
    gate_reason_codes: { settlement: ['SETTLEMENT_REDERIVATION_MISMATCH'] },
  },
});
