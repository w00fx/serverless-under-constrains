// BR-RUA-029 matrix row 2: "Verified treatment, exact effect, successful terminal processing ->
// pass, true". The Durable treatment runs the BR-RUA-025 path in full (targeted commit, caller
// timeout, signal, observation, release), so treatment fidelity is verified; the provider declines
// the step retry, so the ledger holds only the authorized transaction. The scenario builder has no
// variant that finishes such a request successfully, so the case records the request's terminal
// state as SUCCEEDED, the only input BR-RUA-030 reads besides the verdict (design §8.7 (c)).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-02',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'treatment_fidelity', outcome: 'verified' },
    { rule_id: 'BR-RUA-006', outcome: 'pass' },
    { rule_id: 'BR-RUA-030', outcome: 'true' },
  ],
  base: 'run-durable-treatment',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'rejected' }] }],
    processing: 'completes',
  },
  operations: [
    {
      op: 'set',
      path: '$trial/journals/caller-journal.jsonl',
      select: { record_type: 'request_state_recorded', occurrence: 2 },
      pointer: '/processing_terminal_reason',
      value: 'SUCCEEDED',
    },
  ],
  expected: {
    preservation_verdict: 'pass',
    trial_validity: 'valid',
    processing_terminal_reason: 'SUCCEEDED',
    correct_completion: true,
    gates: { treatment_fidelity: 'verified' },
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'pass', 'BR-RUA-009': 'pass' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
