// AC-RUA-055 rule coverage, BR-RUA-004 fail (BR-RUA-006): the Durable treatment's first step times
// out, so its outcome is ambiguous, yet the caller records the request as NO_EFFECT_CONFIRMED.
// BR-RUA-004 requires every request state at or after an ambiguous outcome to say UNKNOWN, so it
// fails; the ledger holds exactly the authorized transaction, and this one rule failure turns a
// valid trial's verdict into `fail`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'unknown-outcome-not-recorded',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-004', outcome: 'fail' },
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
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
      select: { record_type: 'request_state_recorded', occurrence: 1 },
      pointer: '/effect_knowledge',
      value: 'NO_EFFECT_CONFIRMED',
    },
  ],
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'pass', 'BR-RUA-004': 'fail', 'BR-RUA-009': 'pass' },
  },
});
