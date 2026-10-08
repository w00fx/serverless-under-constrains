// AC-RUA-055 rule coverage, `ledger_access` invalid (BR-RUA-005, BR-RUA-009): the treatment
// trial's ledger lists two items under one provider_transaction_id. A ledger whose transaction ids
// are not unique cannot be read as the provider's transactions, so ledger access is `invalid`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

/** The first ledger item's transaction id, as the builder derives it. */
const FIRST_TRANSACTION = '00c37040-7e90-468a-ae4c-4154e2256e84';

export default defineGoldenCase({
  case_id: 'duplicate-ledger-transaction',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'ledger_access', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  operations: [
    {
      op: 'set',
      path: '$trial/ledger/ledger-snapshot.json',
      pointer: '/transactions/1/provider_transaction_id',
      value: FIRST_TRANSACTION,
    },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    gates: { ledger_access: 'invalid' },
    gate_reason_codes: { ledger_access: ['DUPLICATE_LEDGER_TRANSACTION_ID'] },
  },
});
