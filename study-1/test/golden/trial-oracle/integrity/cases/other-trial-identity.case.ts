// AC-RUA-041 case 2 (BR-RUA-008, BR-RUA-029): "an execution identity from another trial". In the
// second trial of the run (the Durable CONTROL), the provider's `provider_call_received` names the
// first trial's identity and trial manifest digest. A verdict-critical record correlated to another
// trial makes traceability `invalid`, so the trial is invalid and preservation `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

/** The run's first trial, as the builder derives it. */
const FIRST_TRIAL = 'd1d0a2b9-d331-4919-a5e0-44819414b6e9';

export default defineGoldenCase({
  case_id: 'other-trial-identity',
  ac_ids: ['AC-RUA-041'],
  rule_outcomes_reached: [
    { rule_id: 'traceability', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-durable-control',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_call_received' },
      pointer: '/trial_id',
      value: FIRST_TRIAL,
    },
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_call_received' },
      pointer: '/trial_manifest_sha256',
      value: `@sha256(trials/${FIRST_TRIAL}/trial-manifest.json)`,
    },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    gates: { traceability: 'invalid' },
  },
});
