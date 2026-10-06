// AC-RUA-009 (BR-RUA-007, BR-RUA-031): the same four frozen trials, except that the Durable
// treatment's provider polled its barrier every 500 ms instead of the 250 ms both treatment trials
// must share (OR-RUA-002). That difference is not a declared variant difference, so BR-RUA-007
// reports `UNDECLARED_DIFFERENCE: treatment_parameters.treatment_poll_interval_ms` and the
// comparison is ineligible, while every individual verdict stays intact: the four oracle results
// are byte-identical to those of `ac009-all-projections-equal`.

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import { BASE_TRANSACTIONS, CLEAN_CLOSURE, frozenRunOperations } from '../support/run-fixture.ts';

export default defineGoldenCase({
  case_id: 'ac009-undeclared-difference',
  ac_ids: ['AC-RUA-009'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-007', outcome: 'fail' },
    { rule_id: 'BR-RUA-031', outcome: 'ineligible' },
  ],
  base: 'run-durable-treatment',
  operations: [
    ...frozenRunOperations(BASE_TRANSACTIONS, CLEAN_CLOSURE),
    {
      op: 'set',
      path: '$trial/state/provider-trial-configuration.json',
      pointer: '/treatment_poll_interval_ms',
      value: 500,
    },
  ],
  expected: {
    equality_result: 'fail',
    projection_results: {
      financial_inputs: 'pass',
      control_parameters: 'pass',
      treatment_parameters: 'fail',
      message_source_protocol: 'pass',
      provider_configuration: 'pass',
      controller_configuration: 'pass',
      caller_timing: 'pass',
      observation_window: 'pass',
    },
    comparison_eligibility: 'ineligible',
    ineligibility_reason: { code: 'UNDECLARED_DIFFERENCE', subject: 'treatment_parameters.treatment_poll_interval_ms' },
    failing_checks: ['EQUALITY_PASSES'],
    verdicts: ['pass', 'pass', 'fail', 'fail'],
    oracle_results_identical_to: 'ac009-all-projections-equal',
  },
});
