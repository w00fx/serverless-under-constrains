// AC-RUA-032 case: a missing timestamp. The provider journal holds no provider_commit_confirmed
// (its later events are resequenced, so no gap stands in for the absence). Expected from
// BR-RUA-010 ('missing timestamps are indeterminate') and D-24: the verdict is `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'missing-timestamp',
  ac_ids: ['AC-RUA-032'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-010', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-027', outcome: 'indeterminate' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'remove_record',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_commit_confirmed' },
    },
    { op: 'resequence', path: '$trial/journals/provider-journal.jsonl' },
  ],
  expected: {
    transport_probe_verdict: 'indeterminate',
    conditions: { 'BR-RUA-010': 'indeterminate' },
    treatment_fidelity: 'unverified',
  },
});
