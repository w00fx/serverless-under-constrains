// AC-RUA-012 (BR-RUA-006, BR-RUA-043; CTR-RUA-002): the initial hypothesis expects both treatment
// variants to create two successful transactions. Here the Durable treatment's second attempt is
// rejected, so its ledger holds one transaction and its oracle result passes, contradicting the
// hypothesis. Its request ended PROVIDER_REJECTED, so that pass is not a correct completion
// (BR-RUA-030). The run summary still reports all four trials, in declared order, each with its
// oracle result's verdict and completion copied unaltered: nothing is filtered, reordered or
// annotated, and the summary names no winner, aggregate or statistic.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import {
  BASE_TERMINAL_REASONS,
  BASE_TRANSACTIONS,
  CLEAN_CLOSURE,
  frozenRunOperations,
} from '../support/run-fixture.ts';
import {
  HYPOTHESIS_CONTRADICTING_TERMINAL_REASON,
  HYPOTHESIS_CONTRADICTING_TRANSACTIONS,
} from '../support/contradicting-ledger.ts';

export default defineGoldenCase({
  case_id: 'ac012-summary-includes-all-four',
  ac_ids: ['AC-RUA-012'],
  rule_outcomes_reached: [{ rule_id: 'BR-RUA-006', outcome: 'pass' }],
  base: 'run-durable-treatment',
  plan: {
    deliveries: [{ attempts: [{ behavior: 'targeted_timeout' }, { behavior: 'rejected' }] }],
    processing: 'completes',
  },
  operations: frozenRunOperations(
    [
      BASE_TRANSACTIONS[0] ?? [],
      BASE_TRANSACTIONS[1] ?? [],
      BASE_TRANSACTIONS[2] ?? [],
      HYPOTHESIS_CONTRADICTING_TRANSACTIONS,
    ],
    CLEAN_CLOSURE,
    [
      BASE_TERMINAL_REASONS[0] ?? 'SUCCEEDED',
      BASE_TERMINAL_REASONS[1] ?? 'SUCCEEDED',
      BASE_TERMINAL_REASONS[2] ?? 'SUCCEEDED',
      HYPOTHESIS_CONTRADICTING_TERMINAL_REASON,
    ],
  ),
  expected: {
    trial_results: [
      {
        sequence: 1,
        variant_id: 'conventional',
        scenario: 'CONTROL',
        execution_status: 'completed',
        preservation_verdict: 'pass',
        correct_completion: true,
      },
      {
        sequence: 2,
        variant_id: 'durable',
        scenario: 'CONTROL',
        execution_status: 'completed',
        preservation_verdict: 'pass',
        correct_completion: true,
      },
      {
        sequence: 3,
        variant_id: 'conventional',
        scenario: 'COMMIT_THEN_TIMEOUT',
        execution_status: 'completed',
        preservation_verdict: 'fail',
        correct_completion: false,
      },
      {
        sequence: 4,
        variant_id: 'durable',
        scenario: 'COMMIT_THEN_TIMEOUT',
        execution_status: 'completed',
        preservation_verdict: 'pass',
        correct_completion: false,
      },
    ],
    summary_members: [
      'cleanup_result_ref',
      'cleanup_status',
      'comparison_assessment_ref',
      'comparison_eligibility',
      'comparison_ineligibility_reasons',
      'created_at',
      'evidence_integrity_status',
      'execution_manifest_sha256',
      'execution_status',
      'late_evidence_assessment_ref',
      'leak_audit_status',
      'lease_status',
      'record_type',
      'run_id',
      'run_terminal_reason',
      'safety_status',
      'schema_version',
      'trial_results',
    ],
    trial_result_members: [
      'correct_completion',
      'execution_status',
      'incompletion_reasons',
      'oracle_result_ref',
      'preservation_verdict',
      'scenario',
      'sequence',
      'trial_id',
      'variant_id',
    ],
  },
});
