// AC-RUA-031 case BR-RUA-015: the caller observed the targeted call's success. The targeted
// attempt's outcome is SUCCEEDED and carries the committed call and transaction ids. Expected from
// BR-RUA-015 ('the caller must never observe a successful provider response for the targeted
// attempt') and D-26: the condition fails, the verdict is `fail`, fidelity is invalid.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'br015-caller-observed-success',
  ac_ids: ['AC-RUA-031'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-011', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-015', outcome: 'fail' },
    { rule_id: 'BR-RUA-027', outcome: 'fail' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'attempt_outcome_recorded' },
      pointer: '/outcome',
      value: 'SUCCEEDED',
    },
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'attempt_outcome_recorded' },
      pointer: '/provider_call_id',
      value: 'cacf9887-bd96-4e98-868e-5d38dfbf3235',
    },
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'attempt_outcome_recorded' },
      pointer: '/provider_transaction_id',
      value: '83edf5ce-1e34-469c-8bf3-0a9fa87ec885',
    },
  ],
  expected: { transport_probe_verdict: 'fail', conditions: { 'BR-RUA-015': 'fail' }, treatment_fidelity: 'invalid' },
});
