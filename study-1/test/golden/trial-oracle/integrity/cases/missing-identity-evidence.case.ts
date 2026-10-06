// AC-RUA-017 case 2 (INV-RUA-001, BR-RUA-029): "missing identity evidence makes it `unverified`".
// The caller journal lacks the attempt's `attempt_registered`, the event that records the
// caller-generated physical identities; the dispatch that follows it now names the invocation as its
// cause, so causation still resolves and only the identity evidence is missing. The ledger still
// proves the one transaction, so the monetary observations stay reported.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const CALLER_JOURNAL = '$trial/journals/caller-journal.jsonl';
/** The base trial's `caller_invocation_started`, as the builder derives it. */
const INVOCATION_STARTED = 'bcbdb92f-ccf1-4694-860d-7315ab99d59d';

export default defineGoldenCase({
  case_id: 'missing-identity-evidence',
  ac_ids: ['AC-RUA-017'],
  rule_outcomes_reached: [
    { rule_id: 'identity_integrity', outcome: 'unverified' },
    { rule_id: 'BR-RUA-003', outcome: 'not_applicable' },
    { rule_id: 'BR-RUA-029', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'set',
      path: CALLER_JOURNAL,
      select: { record_type: 'dispatch_started' },
      pointer: '/causation_event_ids',
      value: [INVOCATION_STARTED],
    },
    { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'attempt_registered' } },
    { op: 'resequence', path: CALLER_JOURNAL },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'indeterminate',
    correct_completion: null,
    identity_integrity: 'unverified',
    gates: { identity_integrity: 'unverified', traceability: 'verified' },
    monetary_observations: { successful_transaction_count: 1, refunded_total_minor: '10000', ledger_complete: true },
  },
});
