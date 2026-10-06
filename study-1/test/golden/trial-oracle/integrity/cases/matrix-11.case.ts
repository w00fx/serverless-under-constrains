// BR-RUA-029 matrix row 11: "Invalid manifest rejected before workload -> no oracle result, null".
// The canonical CONTROL trial's execution manifest lacks its approved financial inputs, so it does
// not conform to its schema and names no usable execution. The oracle refuses to evaluate a trial
// of an execution it cannot identify: no oracle result exists, and correct completion is `null`
// for a trial that never validly started (BR-RUA-030).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'matrix-11',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [{ rule_id: 'BR-RUA-030', outcome: 'null' }],
  base: 'run-conventional-control',
  operations: [{ op: 'remove', path: 'admission/execution-manifest.json', pointer: '/financial_inputs' }],
  expected: {
    oracle_result: 'none',
    refusal_codes: ['TRIAL_EXECUTION_UNKNOWN'],
    correct_completion: null,
  },
});
