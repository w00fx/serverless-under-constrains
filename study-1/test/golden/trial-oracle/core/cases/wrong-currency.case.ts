// AC-RUA-013 (BR-RUA-001, -009), wrong currency: "exactly one successful transaction with an
// incorrect amount, currency, request identity, or payment identity; BR-RUA-001 may pass its count
// check, but BR-RUA-009 fails; preservation is fail." The CONTROL trial's single attempt sends
// currency USD instead of the payment's BRL, so the provider commits the one transaction with it.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'wrong-currency',
  ac_ids: ['AC-RUA-013'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
  ],
  base: 'run-conventional-control',
  plan: { deliveries: [{ attempts: [{ behavior: 'succeeded', currency: 'USD' }] }], processing: 'completes' },
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 1, ledger_complete: true },
  },
});
