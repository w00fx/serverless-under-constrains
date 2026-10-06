// AC-RUA-047 case 6 (BR-RUA-034): "Duplicate ledger transaction identity invalidates the ledger
// snapshot." Both transactions of the conventional treatment trial's ledger carry one
// `provider_transaction_id`. Expected: DUPLICATE_LEDGER_TRANSACTION_ID naming that id; the
// snapshot still holds both transactions (LEDGER_LARGER_THAN_EXPECTED, never truncated); and,
// because a duplicate provider-generated transaction identity makes evidence integrity invalid
// (INV-RUA-001), evidence integrity is invalid.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'duplicate-ledger-tx-id',
  ac_ids: ['AC-RUA-047'],
  rule_outcomes_reached: [],
  base: 'run-conventional-treatment',
  operations: [
    {
      op: 'set',
      path: '$trial/ledger/ledger-snapshot.json',
      pointer: '/transactions/0/provider_transaction_id',
      value: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
    },
    {
      op: 'set',
      path: '$trial/ledger/ledger-snapshot.json',
      pointer: '/transactions/1/provider_transaction_id',
      value: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d',
    },
  ],
  expected: {
    finding_codes: ['DUPLICATE_LEDGER_TRANSACTION_ID', 'LEDGER_LARGER_THAN_EXPECTED'],
    ledger: {
      status: 'present',
      transaction_count: 2,
      duplicate_transaction_ids: ['5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d'],
    },
    gates: { evidence_integrity: 'invalid' },
  },
});
