// AC-RUA-041 case 1 (BR-RUA-008, BR-RUA-029): "a provider call without execution identity". The
// provider's `provider_call_received`, a verdict-critical record, carries no run_id, so it cannot be
// correlated to the active execution: missing correlation makes traceability `unverified` and
// preservation `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'missing-execution-identity',
  ac_ids: ['AC-RUA-041'],
  rule_outcomes_reached: [
    { rule_id: 'traceability', outcome: 'unverified' },
    { rule_id: 'control_integrity', outcome: 'unverified' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'remove',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_call_received' },
      pointer: '/run_id',
    },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { traceability: 'unverified' },
  },
});
