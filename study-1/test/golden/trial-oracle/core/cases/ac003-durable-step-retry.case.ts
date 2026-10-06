// AC-RUA-003 (BR-RUA-003, -004, -020), Durable step-retry path: "every attempt retains the logical
// refund identity; aggregate effect knowledge remains UNKNOWN; every provider call and transaction
// is preserved; the oracle returns the evidence-derived preservation verdict." The base Durable
// treatment trial is the case: one delivery, one Durable execution whose first step attempt is
// TIMED_OUT after its targeted commit and whose retry succeeds and commits again. Both attempts
// carry `ref-poc-001`, the caller records UNKNOWN after each, the projection keeps both calls, both
// transactions and the execution, and the evidence-derived verdict is fail (BR-RUA-001).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac003-durable-step-retry',
  ac_ids: ['AC-RUA-003'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-003', outcome: 'pass' },
    { rule_id: 'BR-RUA-004', outcome: 'pass' },
    { rule_id: 'treatment_fidelity', outcome: 'verified' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
  ],
  base: 'run-durable-treatment',
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    rules: { 'BR-RUA-003': 'pass', 'BR-RUA-004': 'pass' },
    projection: {
      attempt_count: 2,
      refund_request_ids: ['ref-poc-001', 'ref-poc-001'],
      outcomes: ['TIMED_OUT', 'SUCCEEDED'],
      knowledge_after_recorded: ['UNKNOWN', 'UNKNOWN'],
      provider_call_count: 2,
      transaction_count: 2,
      durable_execution_count: 1,
    },
  },
});
