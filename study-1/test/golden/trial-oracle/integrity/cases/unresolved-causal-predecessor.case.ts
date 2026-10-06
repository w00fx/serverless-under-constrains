// AC-RUA-041 case 3 (BR-RUA-008, BR-RUA-029): "an unresolved causal predecessor". The provider's
// `provider_call_accepted` names a causal predecessor that no journal of the execution holds, so the
// causal chain from the call to its commit cannot be traced: traceability is `unverified` and
// preservation `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

/** A causal predecessor no journal holds: a fresh UUIDv4. */
const MISSING_PREDECESSOR = '4b8e2a6c-9d1f-4c37-a5e0-6f2b8d4a1c93';

export default defineGoldenCase({
  case_id: 'unresolved-causal-predecessor',
  ac_ids: ['AC-RUA-041'],
  rule_outcomes_reached: [
    { rule_id: 'traceability', outcome: 'unverified' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'set',
      path: '$trial/journals/provider-journal.jsonl',
      select: { record_type: 'provider_call_accepted' },
      pointer: '/causation_event_ids',
      value: [MISSING_PREDECESSOR],
    },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    gates: { traceability: 'unverified' },
  },
});
