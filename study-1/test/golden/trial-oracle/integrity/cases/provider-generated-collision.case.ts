// AC-RUA-017 case 3 (INV-RUA-001, BR-RUA-029, BR-RUA-034): "a provider-generated collision makes
// evidence integrity `invalid`". Another provider invocation records receiving a call under the
// provider_call_id the provider already generated for the trial's one call: an identity only the
// provider generates is used by two origin events. Provider identities are evidence of the
// provider's own integrity, so the collision makes evidence integrity, not identity integrity,
// invalid. The ledger still proves the one transaction, so the monetary observations stay reported.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const PROVIDER_JOURNAL = '$trial/journals/provider-journal.jsonl';
/** The second invocation and its event: fresh UUIDv4s. */
const SECOND_INSTANCE = '2c7e9b14-6f3a-4d85-a0b2-8e1d5c7a9f63';
const SECOND_RECEIVED = '8a4f2d6b-1e9c-4b73-95d0-3f6a8c2e4b17';

export default defineGoldenCase({
  case_id: 'provider-generated-collision',
  ac_ids: ['AC-RUA-017'],
  rule_outcomes_reached: [
    { rule_id: 'evidence_integrity', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'clone_record',
      path: PROVIDER_JOURNAL,
      select: { record_type: 'provider_call_received' },
      set: [
        { pointer: '/event_id', value: SECOND_RECEIVED },
        { pointer: '/source_instance_id', value: SECOND_INSTANCE },
        { pointer: '/source_sequence', value: 1 },
        { pointer: '/occurred_at', value: '2026-10-05T12:05:05.600Z' },
      ],
    },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    gates: { evidence_integrity: 'invalid', identity_integrity: 'verified' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
