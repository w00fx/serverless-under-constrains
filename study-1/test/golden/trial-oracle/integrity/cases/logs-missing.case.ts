// AC-RUA-054 (BR-RUA-037): "logs missing". A verified treatment trial with two successful
// transactions, a proven duplicate, whose logs were unavailable when collected. Telemetry is a
// diagnostic and never an oracle input, so the verdict is derived from the complete primary evidence
// exactly as with telemetry present (`fail`, completion `false`: BR-RUA-029 "proven duplicate with
// optional telemetry missing"), and the unavailability stays recorded in the telemetry evidence.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

export default defineGoldenCase({
  case_id: 'logs-missing',
  ac_ids: ['AC-RUA-054'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-conventional-treatment',
  operations: [
    {
      op: 'set',
      path: '$trial/telemetry/telemetry-availability.json',
      pointer: '/logs',
      value: {
        availability: 'unavailable',
        locators: [],
        reasons: [
          {
            code: 'TELEMETRY_UNAVAILABLE',
            subject: 'BR-RUA-037',
            detail: 'the logs could not be read when the trial was collected; expected them available',
          },
        ],
      },
    },
  ],
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
  },
});
