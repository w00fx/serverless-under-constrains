// AC-RUA-047 case 7 (BR-RUA-034): "Incomplete ledger pagination makes the ledger incomplete." The
// control trial's single ledger page still has a `next_cursor`, so the snapshot does not prove it
// read the whole partition (design §8.2 I7: the last page has no cursor). Expected:
// LEDGER_PAGINATION_INCOMPLETE and an incomplete ledger; evidence integrity is not affected.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'incomplete-pagination',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'set',
      path: '$trial/ledger/ledger-snapshot.json',
      pointer: '/pages/0/next_cursor',
      value: 'page-2',
    },
  ],
  expected: {
    finding_codes: ['LEDGER_PAGINATION_INCOMPLETE'],
    ledger: { status: 'present', pagination_complete: false },
    gates: { evidence_integrity: 'verified' },
  },
});
