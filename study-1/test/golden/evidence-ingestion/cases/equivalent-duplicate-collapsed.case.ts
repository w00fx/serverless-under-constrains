// AC-RUA-047 case 1 (BR-RUA-034): "Repeated `event_id` with structurally equivalent parsed JSON is
// an ingestion duplicate and is collapsed with a diagnostic count." The caller journal of the
// conventional control trial holds its `dispatch_started` twice with identical content. Expected:
// one EQUIVALENT_DUPLICATE_COLLAPSED finding, a collapsed count of 1, and no gate affected
// (design §8.2 I4: collapse is not an integrity fault).

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'equivalent-duplicate-collapsed',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'clone_record',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'dispatch_started' },
      set: [],
    },
  ],
  expected: {
    finding_codes: ['EQUIVALENT_DUPLICATE_COLLAPSED'],
    collapsed_duplicate_count: 1,
    gates: { traceability: 'verified', identity_integrity: 'verified', evidence_integrity: 'verified' },
  },
});
