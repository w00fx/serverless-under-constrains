// AC-RUA-007 case 1 (BR-RUA-006, -029, -032): "ledger access is incomplete; affected rule checks are
// indeterminate; preservation is indeterminate; structured reasons identify the missing evidence."
// The treatment trial's only ledger page still has a `next_cursor`, so the read is not proven
// complete (BR-RUA-034). The partial page already shows both transactions, a duplicate, yet the
// monetary basis is not conclusive (D-15), so BR-RUA-001, -002 and -009 are indeterminate instead
// of fail, and the reasons name the ledger snapshot.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac007-ledger-pagination-incomplete',
  ac_ids: ['AC-RUA-007'],
  rule_outcomes_reached: [
    { rule_id: 'ledger_access', outcome: 'unverified' },
    { rule_id: 'BR-RUA-001', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-002', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-009', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  operations: [
    { op: 'set', path: '$trial/ledger/ledger-snapshot.json', pointer: '/pages/0/next_cursor', value: 'page-2' },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { ledger_access: 'unverified' },
    gate_reason_codes: { ledger_access: ['LEDGER_PAGINATION_INCOMPLETE'] },
    rules: { 'BR-RUA-001': 'indeterminate', 'BR-RUA-002': 'indeterminate', 'BR-RUA-009': 'indeterminate' },
    rule_reason_codes: {
      'BR-RUA-001': ['LEDGER_INCOMPLETE'],
      'BR-RUA-002': ['LEDGER_INCOMPLETE'],
      'BR-RUA-009': ['LEDGER_INCOMPLETE'],
    },
    reason_codes_by_artifact: {
      '$trial/ledger/ledger-snapshot.json': ['LEDGER_INCOMPLETE', 'LEDGER_PAGINATION_INCOMPLETE'],
    },
    monetary_observations: { successful_transaction_count: 2, ledger_complete: false },
  },
});
