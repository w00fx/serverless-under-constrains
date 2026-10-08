// AC-RUA-040 (BR-RUA-002, -009): "exactly one successful transaction of 20000 minor units against a
// captured 10000; BR-RUA-001 passes its count check, but BR-RUA-002 and BR-RUA-009 fail;
// preservation is fail." The CONTROL trial's single attempt asks for 20000 and the provider
// commits it.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'single-20000-tx',
  ac_ids: ['AC-RUA-040'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-002', outcome: 'fail' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
  ],
  base: 'run-conventional-control',
  plan: { deliveries: [{ attempts: [{ behavior: 'succeeded', amount_minor: 20000 }] }], processing: 'completes' },
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '20000', ledger_complete: true },
  },
});
