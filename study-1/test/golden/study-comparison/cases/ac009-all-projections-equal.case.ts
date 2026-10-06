// AC-RUA-009 (BR-RUA-007, BR-RUA-020, BR-RUA-031): all four canonical trials, frozen and closed
// cleanly. The declared common inputs and treatment parameters compare equal and only the declared
// variant difference remains (the source visibility timeout, 60 s versus 360 s), so every equality
// projection passes and the comparison is eligible. Both controls pass and both treatments fail with
// two transactions each: neither verdict affects eligibility (BR-RUA-031).

import { defineGoldenCase } from '../../../support/golden-builder/golden-case.ts';
import { BASE_TRANSACTIONS, CLEAN_CLOSURE, frozenRunOperations } from '../support/run-fixture.ts';

export default defineGoldenCase({
  case_id: 'ac009-all-projections-equal',
  ac_ids: ['AC-RUA-009'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-007', outcome: 'pass' },
    { rule_id: 'BR-RUA-031', outcome: 'eligible' },
  ],
  base: 'run-durable-treatment',
  operations: frozenRunOperations(BASE_TRANSACTIONS, CLEAN_CLOSURE),
  expected: {
    equality_result: 'pass',
    projection_results: {
      financial_inputs: 'pass',
      control_parameters: 'pass',
      treatment_parameters: 'pass',
      message_source_protocol: 'pass',
      provider_configuration: 'pass',
      controller_configuration: 'pass',
      caller_timing: 'pass',
      observation_window: 'pass',
    },
    declared_differences: [{ projection_id: 'message_source_protocol', field: 'source_visibility_timeout_ms' }],
    comparison_eligibility: 'eligible',
    comparison_ineligibility_reasons: [],
    verdicts: ['pass', 'pass', 'fail', 'fail'],
  },
});
