// AC-RUA-047 case 3 (BR-RUA-034): "Conflicting events under one source and sequence make evidence
// integrity invalid." A copy of the caller's `attempt_outcome_recorded` under a new `event_id`
// occupies the same `(source, source_instance_id, source_sequence)`. Expected:
// CONFLICTING_SOURCE_SEQUENCE and evidence integrity invalid.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'conflicting-source-sequence',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'clone_record',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'attempt_outcome_recorded' },
      set: [{ pointer: '/event_id', value: '7d1c4f5e-2b3a-4c6d-8e9f-0a1b2c3d4e5f' }],
    },
  ],
  expected: {
    finding_codes: ['CONFLICTING_SOURCE_SEQUENCE'],
    gates: { evidence_integrity: 'invalid' },
  },
});
