// AC-RUA-047 case 4 (BR-RUA-034): "A dense source-sequence gap makes checks relying on that source
// instance indeterminate." The caller's last event moves from sequence 5 to 6, so 5 is absent.
// Expected: SOURCE_SEQUENCE_GAP; the caller instance is gapped; identity integrity, which relies on
// the caller journal, is unverified (design §8.3 G3); evidence integrity is not affected (a gap is
// not among the G8 invalidating findings).

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'sequence-gap',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'request_state_recorded' },
      pointer: '/source_sequence',
      value: 6,
    },
  ],
  expected: {
    finding_codes: ['SOURCE_SEQUENCE_GAP'],
    gapped_instance_count: 1,
    gates: { traceability: 'verified', identity_integrity: 'unverified', evidence_integrity: 'verified' },
  },
});
