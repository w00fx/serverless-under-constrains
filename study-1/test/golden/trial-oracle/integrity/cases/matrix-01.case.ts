// BR-RUA-029 matrix row 1: "Valid control, exact effect, successful terminal processing -> pass,
// true". The canonical CONTROL trial: one delivery, one call, one transaction, every applicable gate verified,
// BR-RUA-001, -002, -003 and -009 pass and the request finishes SUCCEEDED (BR-RUA-030). No attempt
// is ambiguous, so BR-RUA-004 does not apply; a CONTROL trial is judged by G4a, so G4b does not.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-01',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'independent_oracle', outcome: 'verified' },
    { rule_id: 'traceability', outcome: 'verified' },
    { rule_id: 'identity_integrity', outcome: 'verified' },
    { rule_id: 'control_integrity', outcome: 'verified' },
    { rule_id: 'treatment_fidelity', outcome: 'not_applicable' },
    { rule_id: 'ledger_access', outcome: 'verified' },
    { rule_id: 'settlement', outcome: 'verified' },
    { rule_id: 'rule_evidence', outcome: 'verified' },
    { rule_id: 'evidence_integrity', outcome: 'verified' },
    { rule_id: 'BR-RUA-001', outcome: 'pass' },
    { rule_id: 'BR-RUA-002', outcome: 'pass' },
    { rule_id: 'BR-RUA-003', outcome: 'pass' },
    { rule_id: 'BR-RUA-004', outcome: 'not_applicable' },
    { rule_id: 'BR-RUA-009', outcome: 'pass' },
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
    gates: {
      independent_oracle: 'verified',
      traceability: 'verified',
      identity_integrity: 'verified',
      control_integrity: 'verified',
      treatment_fidelity: 'not_applicable',
      ledger_access: 'verified',
      settlement: 'verified',
      rule_evidence: 'verified',
      evidence_integrity: 'verified',
    },
    rules: {
      'BR-RUA-001': 'pass',
      'BR-RUA-002': 'pass',
      'BR-RUA-003': 'pass',
      'BR-RUA-004': 'not_applicable',
      'BR-RUA-009': 'pass',
    },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
