// AC-RUA-031 case BR-RUA-013: the controller signal names only the caller timeout as its cause,
// lacking the provider commit. Expected from BR-RUA-013 ('immediately caused by both provider
// commit and caller timeout') and design §8.10: the condition fails, the verdict is `fail`,
// fidelity is invalid.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'br013-wrong-signal-causation',
  ac_ids: ['AC-RUA-031'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-013', outcome: 'fail' },
    { rule_id: 'BR-RUA-027', outcome: 'fail' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/controller-journal.jsonl',
      select: { record_type: 'timeout_signal_recorded' },
      pointer: '/causation_event_ids',
      value: ['d0a0cf75-0e50-4bf4-b26f-0084786d51cf'],
    },
  ],
  expected: { transport_probe_verdict: 'fail', conditions: { 'BR-RUA-013': 'fail' }, treatment_fidelity: 'invalid' },
});
