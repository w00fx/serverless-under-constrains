// AC-RUA-005 (BR-RUA-001, -009): "an approved request with zero successful transactions in a
// complete settled ledger; BR-RUA-001 and BR-RUA-009 fail; preservation is fail." The Durable
// CONTROL trial's complete ledger snapshot lists no transaction (its one page holds no item);
// everything else, settlement included, is the base.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac005-zero-tx',
  ac_ids: ['AC-RUA-005'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
  ],
  base: 'run-durable-control',
  operations: [
    { op: 'set', path: '$trial/ledger/ledger-snapshot.json', pointer: '/transactions', value: [] },
    { op: 'set', path: '$trial/ledger/ledger-snapshot.json', pointer: '/pages/0/item_count', value: 0 },
  ],
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 0, refunded_total_minor: '0', ledger_complete: true },
  },
});
