// AC-RUA-050 (BR-RUA-031, BR-RUA-052): cleanup failed and the audit still saw the run's event-source
// mapping, a `processing_capable` leak that could still produce later correlated processing or
// monetary effects (D-30). It compromises settlement and comparison eligibility, so the comparison is
// ineligible, and still every frozen verdict is unchanged.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import { BASE_TRANSACTIONS, frozenRunOperations, leakedResource } from '../support/run-fixture.ts';

export default defineGoldenCase({
  case_id: 'leak-capable-of-correlated-effects',
  ac_ids: ['AC-RUA-050'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-031', outcome: 'ineligible' },
    { rule_id: 'BR-RUA-052', outcome: 'compromised' },
  ],
  base: 'run-durable-treatment',
  operations: frozenRunOperations(BASE_TRANSACTIONS, {
    cleanup_status: 'failed',
    leaks: [leakedResource('processing_capable')],
    final_lease_event: 'RECOVERY_REQUIRED',
  }),
  expected: {
    comparison_eligibility: 'ineligible',
    ineligibility_reason: { code: 'ISOLATION_COMPROMISING_LEAK', subject: '0d6f4c2e-8a1b-4d3c-9e7f-5a6b7c8d9e0f' },
    failing_checks: ['NO_ISOLATION_COMPROMISING_LEAK'],
    cleanup_status: 'failed',
    leak_audit_status: 'leaks_detected',
    verdicts: ['pass', 'pass', 'fail', 'fail'],
    oracle_results_identical_to: 'ac009-all-projections-equal',
  },
});
