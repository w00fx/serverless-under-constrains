// AC-RUA-004 (BR-RUA-001, -002, -006, -009), valid CONTROL: "two transactions in a valid CONTROL
// trial, where multiple calls do not invalidate control integrity." The caller's single attempt
// reaches the provider twice: a second, untargeted call of the same attempt and provider request
// arrives in another provider invocation, is accepted and commits a second transaction, which the
// complete ledger lists. No timeout and no treatment signal exist, so control integrity stays
// verified, and BR-RUA-001, -002 (20000 > 10000) and -009 fail on a valid trial.

import type { JsonValue } from '../../../../../src/record-contract/primitives.ts';
import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const PROVIDER_JOURNAL = '$trial/journals/provider-journal.jsonl';
const LEDGER = '$trial/ledger/ledger-snapshot.json';
/** The second call's provider invocation, call, events, commit and transaction: fresh UUIDv4s. */
const INSTANCE = '7c1e4a52-9b3d-4f6e-8a21-5d0c3b9e7f14';
const CALL = '3f8a2c61-7d4e-4b19-9c05-e2a6b8d1f374';
const RECEIVED = 'a1d4c7e2-5b8f-4c3a-9e16-0f2b7d5a8c41';
const ACCEPTED = 'b2e5d8f3-6c9a-4d4b-8f27-1a3c8e6b9d52';
const COMMITTED = 'c3f6e9a4-7dab-4e5c-9a38-2b4d9f7cae63';
const CONFIRMED = 'd4a7fab5-8ebc-4f6d-8b49-3c5eaa8dbf74';
const COMMIT = 'e5b8abc6-9fcd-4a7e-9c5a-4d6fbb9ec085';
const TRANSACTION = 'f6c9bcd7-afde-4b8f-8d6b-5e7acc0fd196';
/** The base trial's attempt and provider request, as the builder derives them. */
const ATTEMPT = '46b2ece1-aeea-4e03-ba92-290977fb4518';
const PROVIDER_REQUEST = '8c0589c0-1eb8-4ba4-b0cc-3265d71eca8a';

const inSecondInvocation = (
  sequence: number,
  eventId: string,
  occurredAt: string,
): readonly { readonly pointer: string; readonly value: JsonValue }[] => [
  { pointer: '/source_instance_id', value: INSTANCE },
  { pointer: '/source_sequence', value: sequence },
  { pointer: '/event_id', value: eventId },
  { pointer: '/provider_call_id', value: CALL },
  { pointer: '/occurred_at', value: occurredAt },
];

export default defineGoldenCase({
  case_id: 'ac004-valid-control-two-tx',
  ac_ids: ['AC-RUA-004'],
  rule_outcomes_reached: [
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-002', outcome: 'fail' },
    { rule_id: 'BR-RUA-009', outcome: 'fail' },
    { rule_id: 'control_integrity', outcome: 'verified' },
    { rule_id: 'BR-RUA-006', outcome: 'fail' },
    { rule_id: 'BR-RUA-030', outcome: 'false' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'clone_record',
      path: PROVIDER_JOURNAL,
      select: { record_type: 'provider_call_received' },
      set: inSecondInvocation(1, RECEIVED, '2026-10-05T12:05:05.600Z'),
    },
    {
      op: 'clone_record',
      path: PROVIDER_JOURNAL,
      select: { record_type: 'provider_call_accepted' },
      set: [
        ...inSecondInvocation(2, ACCEPTED, '2026-10-05T12:05:05.605Z'),
        { pointer: '/causation_event_ids', value: [RECEIVED] },
      ],
    },
    {
      op: 'clone_record',
      path: PROVIDER_JOURNAL,
      select: { record_type: 'provider_transaction_committed' },
      set: [
        ...inSecondInvocation(3, COMMITTED, '2026-10-05T12:05:05.620Z'),
        { pointer: '/causation_event_ids', value: [ACCEPTED] },
        { pointer: '/provider_commit_id', value: COMMIT },
        { pointer: '/provider_transaction_id', value: TRANSACTION },
        { pointer: '/commit_requested_at', value: '2026-10-05T12:05:05.620Z' },
      ],
    },
    {
      op: 'clone_record',
      path: PROVIDER_JOURNAL,
      select: { record_type: 'provider_commit_confirmed' },
      set: [
        ...inSecondInvocation(4, CONFIRMED, '2026-10-05T12:05:05.635Z'),
        { pointer: '/causation_event_ids', value: [COMMITTED] },
        { pointer: '/provider_commit_id', value: COMMIT },
        { pointer: '/provider_transaction_id', value: TRANSACTION },
        { pointer: '/committed_at', value: '2026-10-05T12:05:05.630Z' },
      ],
    },
    { op: 'set', path: LEDGER, pointer: '/pages/0/item_count', value: 2 },
    {
      op: 'set',
      path: LEDGER,
      pointer: '/transactions/1',
      value: {
        amount_minor: 10000,
        attempt_id: ATTEMPT,
        commit_requested_at: '2026-10-05T12:05:05.620Z',
        currency: 'BRL',
        payment_id: 'pay-poc-001',
        provider_call_id: CALL,
        provider_commit_id: COMMIT,
        provider_request_id: PROVIDER_REQUEST,
        provider_transaction_id: TRANSACTION,
        refund_request_id: 'ref-poc-001',
        status: 'SUCCEEDED',
      },
    },
  ],
  expected: {
    preservation_verdict: 'fail',
    trial_validity: 'valid',
    correct_completion: false,
    control_integrity: 'verified',
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 2, refunded_total_minor: '20000', ledger_complete: true },
    projection: { provider_call_count: 2, transaction_count: 2 },
  },
});
