// AC-RUA-031 case BR-RUA-011: transport settled first. The caller's timeout record says the
// transport won the arbiter and had settled at the claim. Expected from BR-RUA-011 and BR-RUA-023
// (the timer must win while transport remains unsettled) and A-12 (those values are judged, not
// rejected): the condition fails, the verdict is `fail`, fidelity is invalid.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'br011-transport-settled-first',
  ac_ids: ['AC-RUA-031'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-011', outcome: 'fail' },
    { rule_id: 'BR-RUA-027', outcome: 'fail' },
  ],
  base: 'probe',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'caller_timeout_recorded' },
      pointer: '/arbiter_winner',
      value: 'TRANSPORT',
    },
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'caller_timeout_recorded' },
      pointer: '/transport_settled_at_claim',
      value: true,
    },
  ],
  expected: { transport_probe_verdict: 'fail', conditions: { 'BR-RUA-011': 'fail' }, treatment_fidelity: 'invalid' },
});
