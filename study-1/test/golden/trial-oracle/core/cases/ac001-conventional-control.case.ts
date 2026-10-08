// AC-RUA-001 (BR-RUA-001, -002, -006, -009, -016, -030), conventional variant: "the ledger contains
// exactly the authorized successful transaction; BR-RUA-001, BR-RUA-002 and BR-RUA-009 pass; the
// oracle returns pass; successful terminal processing produces correct_completion = true." The
// base CONTROL trial is the case: one delivery, one call, one transaction, caller FINISHED with
// SUCCEEDED, settled before the ledger read.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac001-conventional-control',
  ac_ids: ['AC-RUA-001'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-002', outcome: 'pass' },
    { rule_id: 'BR-RUA-009', outcome: 'pass' },
    { rule_id: 'control_integrity', outcome: 'verified' },
    { rule_id: 'BR-RUA-029', outcome: 'valid' },
    { rule_id: 'BR-RUA-006', outcome: 'pass' },
    { rule_id: 'BR-RUA-030', outcome: 'true' },
  ],
  base: 'run-conventional-control',
  expected: {
    preservation_verdict: 'pass',
    trial_validity: 'valid',
    processing_terminal_reason: 'SUCCEEDED',
    correct_completion: true,
    control_integrity: 'verified',
    rules: { 'BR-RUA-001': 'pass', 'BR-RUA-002': 'pass', 'BR-RUA-009': 'pass' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
