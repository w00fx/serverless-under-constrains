// AC-RUA-047 case 2 (BR-RUA-034): "Conflicting content under one event identity makes evidence
// integrity invalid." A second copy of the caller's `dispatch_started` keeps its `event_id` and
// sequence but records another `occurred_at`. Expected: CONFLICTING_EVENT_CONTENT, nothing
// collapsed, and evidence integrity invalid.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'conflicting-event-content',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'clone_record',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'dispatch_started' },
      set: [{ pointer: '/occurred_at', value: '2026-10-05T12:59:59.999Z' }],
    },
  ],
  expected: {
    finding_codes: ['CONFLICTING_EVENT_CONTENT'],
    collapsed_duplicate_count: 0,
    gates: { evidence_integrity: 'invalid' },
  },
});
