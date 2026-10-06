// BR-RUA-029 matrix row 6: "Settled valid trial with zero transactions -> fail, false". The
// conventional CONTROL trial with an empty, complete ledger: no authorized refund exists, so
// BR-RUA-001 and -009 fail on a valid trial.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const LEDGER = '$trial/ledger/ledger-snapshot.json';

export default defineGoldenCase({
  case_id: 'matrix-06',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-conventional-control',
  operations: [
    { op: 'set', path: LEDGER, pointer: '/transactions', value: [] },
    { op: 'set', path: LEDGER, pointer: '/pages/0/item_count', value: 0 },
  ],
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 0, refunded_total_minor: '0', ledger_complete: true },
  },
});
