// AC-RUA-052 (BR-RUA-029, -030): "a valid trial whose ledger holds exactly the authorized effect;
// request processing terminates through the dead-letter queue; preservation is pass and
// correct_completion is false." In the conventional treatment trial the first delivery's attempt
// commits (targeted) and times out; the redelivery's commit fails definitively, the message
// reaches its maximum receive count and is moved to the DLQ. The ledger holds the one authorized
// transaction and the terminal reason is RETRIES_EXHAUSTED (§8.7).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'exact-effect-dlq-terminal',
  ac_ids: ['AC-RUA-052'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-002', outcome: 'pass' },
    { rule_id: 'BR-RUA-009', outcome: 'pass' },
    { rule_id: 'settlement', outcome: 'verified' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
    { rule_id: 'BR-RUA-006', outcome: 'pass' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-conventional-treatment',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }, { attempts: [{ behavior: 'commit_failed' }] }],
    processing: 'completes',
  },
  expected: {
    preservation_verdict: 'pass',
    trial_validity: 'valid',
    processing_terminal_reason: 'RETRIES_EXHAUSTED',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'pass', 'BR-RUA-009': 'pass' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
