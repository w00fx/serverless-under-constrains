// AC-RUA-012 (BR-RUA-006, -043): "observed evidence contradicts the initial hypothesis; the
// calculated observations remain unchanged and included; no trial is altered or excluded to
// support the hypothesis." The hypothesis expects every treatment trial to create two successful
// transactions. In this Durable treatment trial the retry step is rejected by the provider, so the
// complete ledger holds the one authorized transaction: BR-RUA-001, -002 and -009 pass and the
// verdict is pass, reported as the evidence gives it. The caller finishes PROVIDER_REJECTED, a
// non-successful terminal reason, so correct_completion is false (BR-RUA-030).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac012-oracle-results-unaltered',
  ac_ids: ['AC-RUA-012'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-002', outcome: 'pass' },
    { rule_id: 'BR-RUA-009', outcome: 'pass' },
    { rule_id: 'treatment_fidelity', outcome: 'verified' },
    { rule_id: 'BR-RUA-006', outcome: 'pass' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-durable-treatment',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'rejected' }] }],
    processing: 'completes',
  },
  expected: {
    preservation_verdict: 'pass',
    trial_validity: 'valid',
    correct_completion: false,
    processing_terminal_reason: 'PROVIDER_REJECTED',
    treatment_fidelity: 'verified',
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'pass', 'BR-RUA-009': 'pass' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
    projection: { attempt_count: 2, outcomes: ['TIMED_OUT', 'REJECTED'], provider_call_count: 2, transaction_count: 1 },
  },
});
