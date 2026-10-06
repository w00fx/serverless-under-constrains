// AC-RUA-031 case BR-RUA-014: the provider released before it observed the timeout. In the one
// provider instance, the release is sequence 5 and the observation sequence 6. Expected from
// BR-RUA-014 ('release only after timeout observation') and design §8.10: the condition fails, the
// verdict is `fail`, fidelity is invalid.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'br014-release-before-observation',
  ac_ids: ['AC-RUA-031'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-014', outcome: 'fail' },
    { rule_id: 'BR-RUA-027', outcome: 'fail' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'treatment_timeout_observed' },
      pointer: '/source_sequence',
      value: 6,
    },
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'treatment_response_released' },
      pointer: '/source_sequence',
      value: 5,
    },
  ],
  expected: { transport_probe_verdict: 'fail', conditions: { 'BR-RUA-014': 'fail' }, treatment_fidelity: 'invalid' },
});
