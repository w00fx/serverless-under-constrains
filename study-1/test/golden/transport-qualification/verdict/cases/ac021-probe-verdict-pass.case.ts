// AC-RUA-021 golden (BR-RUA-026, BR-RUA-027): the probe verdict over clean frozen evidence. Base:
// the transport probe, unchanged: one invocation, one accepted provider call, one committed
// transaction, no safety release. Expected from the spec: `pass` requires every condition to pass,
// valid fidelity, verified evidence and the expected cardinality 1/1/1 (design §14).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac021-probe-verdict-pass',
  ac_ids: ['AC-RUA-021'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-010', outcome: 'pass' },
    { rule_id: 'BR-RUA-011', outcome: 'pass' },
    { rule_id: 'BR-RUA-012', outcome: 'pass' },
    { rule_id: 'BR-RUA-013', outcome: 'pass' },
    { rule_id: 'BR-RUA-014', outcome: 'pass' },
    { rule_id: 'BR-RUA-015', outcome: 'pass' },
    { rule_id: 'BR-RUA-027', outcome: 'pass' },
  ],
  base: 'probe',
  expected: {
    transport_probe_verdict: 'pass',
    probe_validity: 'valid',
    probe_cardinality: { caller_invocations: 1, accepted_provider_calls: 1, committed_transactions: 1 },
    evidence_integrity: 'verified',
    treatment_fidelity: 'verified',
    safety_release_count: 0,
  },
});
