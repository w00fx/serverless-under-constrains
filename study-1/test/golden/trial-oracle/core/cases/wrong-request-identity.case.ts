// AC-RUA-013 (BR-RUA-001, -009), wrong request identity: "exactly one successful transaction with
// an incorrect amount, currency, request identity, or payment identity; BR-RUA-001 may pass its
// count check, but BR-RUA-009 fails; preservation is fail." The CONTROL trial's single attempt
// sends refund request `ref-poc-999` instead of the approved `ref-poc-001`, so the provider commits
// the one transaction with it. The count for the approved refund request is 0, so BR-RUA-001 fails
// too, and the attempt itself no longer carries the approved logical identity, so BR-RUA-003 fails
// (AC-RUA-039).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'wrong-request-identity',
  ac_ids: ['AC-RUA-013'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'BR-RUA-003', outcome: 'fail' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
  ],
  base: 'run-conventional-control',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'succeeded', refund_request_id: 'ref-poc-999' }] }],
    processing: 'completes',
  },
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-003': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 1, ledger_complete: true },
  },
});
