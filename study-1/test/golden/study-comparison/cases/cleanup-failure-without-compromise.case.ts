// AC-RUA-050 (BR-RUA-031, BR-RUA-052): cleanup failed and the audit still saw the run's source queue,
// a `storage_only` leak that holds data but can run nothing (D-30). Isolation, settlement and
// evidence were not compromised, so the comparison stays eligible; the operational failure is
// reported in its own fields, and every frozen verdict is unchanged.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import { BASE_TRANSACTIONS, frozenRunOperations, leakedResource } from '../support/run-fixture.ts';

export default defineGoldenCase({
  case_id: 'cleanup-failure-without-compromise',
  ac_ids: ['AC-RUA-050'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-031', outcome: 'eligible' },
    { rule_id: 'BR-RUA-052', outcome: 'independent' },
  ],
  base: 'run-durable-treatment',
  operations: frozenRunOperations(BASE_TRANSACTIONS, {
    cleanup_status: 'failed',
    leaks: [leakedResource('storage_only')],
    final_lease_event: 'RECOVERY_REQUIRED',
  }),
  expected: {
    comparison_eligibility: 'eligible',
    comparison_ineligibility_reasons: [],
    cleanup_status: 'failed',
    leak_audit_status: 'leaks_detected',
    verdicts: ['pass', 'pass', 'fail', 'fail'],
    oracle_results_identical_to: 'ac009-all-projections-equal',
  },
});
