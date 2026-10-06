// AC-RUA-006 (BR-RUA-005): "variant state claims success but the complete ledger lacks the
// authorized transaction; the ledger controls the monetary result and variant state cannot
// override it." The conventional CONTROL trial's caller still records FINISHED with SUCCEEDED, but
// its complete ledger snapshot lists no transaction. BR-RUA-001 and -009 fail; BR-RUA-002 passes,
// since nothing exceeds the cap. Every monetary rule cites only the ledger snapshot and the two
// business inputs, never the caller's state.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const LEDGER_AND_INPUTS = [
  '$trial/inputs/approved-decision.json',
  '$trial/inputs/payment.json',
  '$trial/ledger/ledger-snapshot.json',
];

export default defineGoldenCase({
  case_id: 'ac006-variant-success-ledger-without-tx',
  ac_ids: ['AC-RUA-006'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-002', outcome: 'pass' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'BR-RUA-005', outcome: 'pass' },
  ],
  base: 'run-conventional-control',
  operations: [
    { op: 'set', path: '$trial/ledger/ledger-snapshot.json', pointer: '/transactions', value: [] },
    { op: 'set', path: '$trial/ledger/ledger-snapshot.json', pointer: '/pages/0/item_count', value: 0 },
  ],
  expected: {
    preservation_verdict: 'fail',
    processing_terminal_reason: 'SUCCEEDED',
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'pass', 'BR-RUA-005': 'pass', 'BR-RUA-009': 'fail' },
    rule_artifacts: {
      'BR-RUA-001': LEDGER_AND_INPUTS,
      'BR-RUA-002': LEDGER_AND_INPUTS,
      'BR-RUA-009': LEDGER_AND_INPUTS,
    },
    monetary_observations: { successful_transaction_count: 0, ledger_complete: true },
  },
});
