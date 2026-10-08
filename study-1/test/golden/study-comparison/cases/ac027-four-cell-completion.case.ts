// AC-RUA-027 (BR-RUA-007, BR-RUA-031, BR-RUA-054): a clean-source canonical run with all four settled
// trial results. Both treatments fail their invariants with two transactions each, as the initial
// hypothesis expects; a `fail` is an admissible observation, so the comparison stays eligible. The
// original closure is clean (cleanup `succeeded`, audit `clean`, lease `released`), the run ends
// `COMPLETED`, the sealed package verifies eligible, and the study is complete.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import { BASE_TRANSACTIONS, CLEAN_CLOSURE, frozenRunOperations } from '../support/run-fixture.ts';

export default defineGoldenCase({
  case_id: 'ac027-four-cell-completion',
  ac_ids: ['AC-RUA-027'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-031', outcome: 'eligible' },
    { rule_id: 'BR-RUA-054', outcome: 'complete' },
  ],
  base: 'run-durable-treatment',
  operations: frozenRunOperations(BASE_TRANSACTIONS, CLEAN_CLOSURE),
  expected: {
    summary: {
      execution_status: 'completed',
      run_terminal_reason: 'COMPLETED',
      comparison_eligibility: 'eligible',
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'released',
      evidence_integrity_status: 'verified',
    },
    verdicts: ['pass', 'pass', 'fail', 'fail'],
    package_eligibility: 'eligible',
    completion: {
      study_completion: 'complete',
      comparison_eligibility: 'eligible',
      package_eligibility: 'eligible',
      cleanup_status: 'succeeded',
      leak_audit_status: 'clean',
      lease_status: 'released',
      run_terminal_reason: 'COMPLETED',
      incompletion_reasons: [],
      checks: [
        { check_id: 'FOUR_ORACLE_RESULTS', holds: true },
        { check_id: 'EQUALITY_EVALUATED', holds: true },
        { check_id: 'EVIDENCE_INTEGRITY_VERIFIED', holds: true },
        { check_id: 'NO_CONTRADICTORY_AMENDMENT', holds: true },
        { check_id: 'NO_KNOWN_SAFETY_BREACH', holds: true },
        { check_id: 'NO_REMAINING_OWNED_RESOURCE', holds: true },
        { check_id: 'CLEAN_SOURCE_AND_MATCHING_QUALIFICATION', holds: true },
      ],
    },
  },
});
