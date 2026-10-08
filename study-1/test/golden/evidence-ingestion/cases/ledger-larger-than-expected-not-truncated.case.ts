// AC-RUA-047 case 9 (BR-RUA-034): "Evidence collection never truncates a ledger because of an
// expected size." The conventional treatment trial commits twice (the spec's Expected Configured
// Trace: 2 successful transactions), one more than the single refund expected. Expected:
// LEDGER_LARGER_THAN_EXPECTED only, both transactions kept, and no gate affected (design §8.2 I7:
// informational).

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ledger-larger-than-expected-not-truncated',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-treatment',
  expected: {
    finding_codes: ['LEDGER_LARGER_THAN_EXPECTED'],
    ledger: { status: 'present', transaction_count: 2, duplicate_transaction_ids: [], pagination_complete: true },
    gates: { traceability: 'verified', identity_integrity: 'verified', evidence_integrity: 'verified' },
  },
});
