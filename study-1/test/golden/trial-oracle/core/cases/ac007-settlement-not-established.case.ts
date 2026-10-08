// AC-RUA-007 case 2 (BR-RUA-006, -029, -032): "settlement is not established by the observation
// deadline; affected rule checks are indeterminate; preservation is indeterminate; structured
// reasons identify the missing evidence." The treatment trial's only delivery ends TIMED_OUT after
// its targeted commit and is never redelivered before the deadline, so processing is still active
// at 600 s: its message is still in flight and its processing is not terminal, so neither the
// runner's assessment nor the oracle's re-derivation finds a settled window (BR-RUA-032), at the
// runner's assessment. No terminal reason exists (D-17), and BR-RUA-001, -002 and -009 are
// indeterminate at the ledger snapshot although it shows the exact effect.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const NOT_SETTLED = ['LEDGER_NOT_INDEPENDENT', 'SETTLEMENT_NOT_ESTABLISHED'];

export default defineGoldenCase({
  case_id: 'ac007-settlement-not-established',
  ac_ids: ['AC-RUA-007'],
  rule_outcomes_reached: [
    { rule_id: 'settlement', outcome: 'unverified' },
    { rule_id: 'independent_oracle', outcome: 'unverified' },
    { rule_id: 'BR-RUA-001', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-002', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-009', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-005', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  plan: { deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }] }], processing: 'active_at_deadline' },
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    processing_terminal_reason: null,
    gates: { independent_oracle: 'unverified', settlement: 'unverified' },
    gate_reason_codes: {
      independent_oracle: ['SETTLEMENT_NOT_ESTABLISHED'],
      settlement: ['PROCESSING_NOT_TERMINAL', 'SOURCE_IN_FLIGHT'],
    },
    rules: { 'BR-RUA-001': 'indeterminate', 'BR-RUA-002': 'indeterminate', 'BR-RUA-009': 'indeterminate' },
    rule_reason_codes: { 'BR-RUA-001': NOT_SETTLED, 'BR-RUA-002': NOT_SETTLED, 'BR-RUA-009': NOT_SETTLED },
    reason_codes_by_artifact: {
      '$trial/ledger/ledger-snapshot.json': ['LEDGER_NOT_INDEPENDENT', 'SETTLEMENT_NOT_ESTABLISHED'],
      'runner/runner-journal.jsonl': ['PROCESSING_NOT_TERMINAL', 'SOURCE_IN_FLIGHT'],
    },
    monetary_observations: { successful_transaction_count: 1, ledger_complete: true },
  },
});
