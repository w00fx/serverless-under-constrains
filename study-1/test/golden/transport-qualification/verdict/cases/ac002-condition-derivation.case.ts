// AC-RUA-002 golden (BR-RUA-010..015, BR-RUA-023, BR-RUA-025): the six conditions derived from the
// probe's frozen evidence. Base: the transport probe, unchanged; its provider commits at
// 12:05:05.130 (provider_commit_confirmed), before the caller timer fires at 12:05:08.040.
// Expected from the spec and design §8.10, §14: all six conditions pass; verified fidelity names
// CA-1 and `causal_plus_cross_source_clock_assumption`; ordering is `cross_source_wall_clock`; the
// BR-RUA-010 `committed_at` is the confirmation's (D-24), not the in-transaction
// `commit_requested_at` (12:05:05.120); the result has no happened-before member.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'ac002-condition-derivation',
  ac_ids: ['AC-RUA-002'],
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
    conditions: {
      'BR-RUA-010': 'pass',
      'BR-RUA-011': 'pass',
      'BR-RUA-012': 'pass',
      'BR-RUA-013': 'pass',
      'BR-RUA-014': 'pass',
      'BR-RUA-015': 'pass',
    },
    treatment_fidelity: 'verified',
    fidelity_basis: 'causal_plus_cross_source_clock_assumption',
    clock_assumption_refs: ['CA-1'],
    ordering_basis: 'cross_source_wall_clock',
    commit_before_timer_observed: {
      committed_at: '2026-10-05T12:05:05.130Z',
      commit_requested_at: '2026-10-05T12:05:05.120Z',
      timer_fired_at: '2026-10-05T12:05:08.040Z',
    },
    happened_before_members: [],
  },
});
