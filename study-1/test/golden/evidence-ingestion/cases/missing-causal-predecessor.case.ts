// AC-RUA-047 case 5 (BR-RUA-034): "Missing required causal predecessors make affected checks
// indeterminate." The caller's `request_state_recorded` names a predecessor that no journal of the
// execution holds. Expected: CAUSAL_PREDECESSOR_MISSING; traceability unverified, because the
// record is verdict-critical (design §8.3 G2; AC-RUA-041 case 3); evidence integrity not affected.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'missing-causal-predecessor',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'request_state_recorded' },
      pointer: '/causation_event_ids',
      value: ['3f2e1d0c-9b8a-4765-a432-10fedcba9876'],
    },
  ],
  expected: {
    finding_codes: ['CAUSAL_PREDECESSOR_MISSING'],
    gates: { traceability: 'unverified', evidence_integrity: 'verified' },
  },
});
