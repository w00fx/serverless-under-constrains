// AC-RUA-017 case 1 (INV-RUA-001, BR-RUA-029): "caller identity reuse makes identity integrity
// `invalid`". The caller registers its one attempt twice: a second `attempt_registered`, another
// event, reuses the caller-generated attempt_id and provider_request_id. The attempt still commits
// once and the complete ledger proves it, so the monetary observations stay reported while the
// verdict is `indeterminate`.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const CALLER_JOURNAL = '$trial/journals/caller-journal.jsonl';
/** The second registration's event: a fresh UUIDv4. */
const SECOND_REGISTRATION = '5d2b8f41-3a6c-4e97-b1d0-7c4e9a2f6b38';

export default defineGoldenCase({
  case_id: 'caller-identity-reuse',
  ac_ids: ['AC-RUA-017'],
  rule_outcomes_reached: [
    { rule_id: 'identity_integrity', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'clone_record',
      path: CALLER_JOURNAL,
      select: { record_type: 'attempt_registered' },
      set: [
        { pointer: '/event_id', value: SECOND_REGISTRATION },
        { pointer: '/occurred_at', value: '2026-10-05T12:05:05.425Z' },
      ],
    },
    { op: 'resequence', path: CALLER_JOURNAL },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    identity_integrity: 'invalid',
    gates: { identity_integrity: 'invalid' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
