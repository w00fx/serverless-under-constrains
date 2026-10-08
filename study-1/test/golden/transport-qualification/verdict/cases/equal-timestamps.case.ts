// AC-RUA-032 case: equal commit and timer timestamps. The confirmation's `committed_at` equals the
// caller's `timer_fired_at` (12:05:08.040). Expected from BR-RUA-010 ('equal or missing timestamps
// are indeterminate') and BR-RUA-027: no condition fails, so the verdict is `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'equal-timestamps',
  ac_ids: ['AC-RUA-032'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-010', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-027', outcome: 'indeterminate' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_commit_confirmed' },
      pointer: '/committed_at',
      value: '2026-10-05T12:05:08.040Z',
    },
  ],
  expected: {
    transport_probe_verdict: 'indeterminate',
    conditions: { 'BR-RUA-010': 'indeterminate' },
    treatment_fidelity: 'unverified',
  },
});
