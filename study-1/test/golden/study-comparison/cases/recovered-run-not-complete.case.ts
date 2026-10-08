// AC-RUA-038 (BR-RUA-054): a canonical run whose original closure was not clean. Cleanup failed, the
// audit still saw the run's source queue, and the lease was marked for recovery. An
// OPERATIONAL_RECOVERY amendment, in a verified selected chain, later repairs all three (effective
// cleanup `succeeded`, audit `clean`, lease `released`). Study completion reads the original package
// only, so the run still cannot complete the study.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import { BASE_TRANSACTIONS, frozenRunOperations, leakedResource } from '../support/run-fixture.ts';

export default defineGoldenCase({
  case_id: 'recovered-run-not-complete',
  ac_ids: ['AC-RUA-038'],
  rule_outcomes_reached: [{ rule_id: 'BR-RUA-054', outcome: 'incomplete' }],
  base: 'run-durable-treatment',
  operations: frozenRunOperations(BASE_TRANSACTIONS, {
    cleanup_status: 'failed',
    leaks: [leakedResource('storage_only')],
    final_lease_event: 'RECOVERY_REQUIRED',
  }),
  expected: {
    original_summary: {
      run_terminal_reason: 'CLEANUP_INCOMPLETE',
      cleanup_status: 'failed',
      leak_audit_status: 'leaks_detected',
      lease_status: 'recovery_required',
    },
    recovered_chain: {
      package_eligibility: 'eligible',
      effective_cleanup_status: 'succeeded',
      effective_leak_audit_status: 'clean',
      effective_lease_status: 'released',
      operational_recovery_applied: true,
    },
    completion: {
      study_completion: 'incomplete',
      package_eligibility: 'eligible',
      cleanup_status: 'failed',
      leak_audit_status: 'leaks_detected',
      lease_status: 'recovery_required',
      run_terminal_reason: 'CLEANUP_INCOMPLETE',
    },
    incompletion_reason_codes: [
      'CLOSURE_NOT_CLEAN',
      'CLOSURE_NOT_CLEAN',
      'CLOSURE_NOT_CLEAN',
      'RUN_NOT_COMPLETED',
      'OWNED_RESOURCE_REMAINS',
    ],
  },
});
