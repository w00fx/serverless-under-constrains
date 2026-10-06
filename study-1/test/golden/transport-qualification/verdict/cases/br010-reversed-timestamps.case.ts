// AC-RUA-031 case BR-RUA-010: reversed commit and timer timestamps. The provider's confirmation
// says it committed at 12:05:08.050, after the caller timer fired at 12:05:08.040. Expected from
// BR-RUA-010 ('reversed timestamps fail') and BR-RUA-027: the condition fails on unaffected
// evidence, so the verdict is `fail` and fidelity is invalid (design §8.10).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'br010-reversed-timestamps',
  ac_ids: ['AC-RUA-031'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-010', outcome: 'fail' },
    { rule_id: 'BR-RUA-027', outcome: 'fail' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_commit_confirmed' },
      pointer: '/committed_at',
      value: '2026-10-05T12:05:08.050Z',
    },
  ],
  expected: { transport_probe_verdict: 'fail', conditions: { 'BR-RUA-010': 'fail' }, treatment_fidelity: 'invalid' },
});
