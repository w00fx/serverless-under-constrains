// AC-RUA-030 case 2 (BR-RUA-031, BR-RUA-043, D-16): contradictory late evidence. After the run's
// final freeze, complete monitoring observes the CONTROL trial's ledger partition again and finds a
// second successful transaction of the same refund that the frozen ledger did not hold. Folded into
// the frozen evidence, the ledger shows two transactions of 10000 for a payment of 10000, so
// BR-RUA-001, -002 and -009 fail on the still valid trial (AC-RUA-004) and the verdict turns from
// `pass` to `fail` with completion `false` (BR-RUA-029, -030): the late evidence is `contradictory`
// (design §8.13 "for example a late ledger transaction"). The frozen result and digests stay
// unchanged, and contradictory late evidence blocks comparison (BR-RUA-031 LATE_EVIDENCE_ACCEPTABLE).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';
import type { LateMonitoring } from '../../../../../src/trial-oracle/late-evidence/late-evidence-input.ts';
import type { UtcMillis } from '../../../../../src/record-contract/primitives.ts';

/** How late monitoring ended for this case (read by the late-evidence golden). */
export const monitoring: LateMonitoring = {
  outcome: 'complete',
  started_at: '2026-10-05T13:30:00.000Z' as UtcMillis,
  ended_at: '2026-10-05T13:45:00.000Z' as UtcMillis,
};

/** The control trial's run, attempt and frozen transaction, as the builder derives them. */
const RUN = 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4';
const TRIAL = 'd1d0a2b9-d331-4919-a5e0-44819414b6e9';
const ATTEMPT = '46b2ece1-aeea-4e03-ba92-290977fb4518';
const PROVIDER_REQUEST = '8c0589c0-1eb8-4ba4-b0cc-3265d71eca8a';
const FROZEN_TRANSACTION = {
  amount_minor: 10000,
  attempt_id: ATTEMPT,
  commit_requested_at: '2026-10-05T12:05:05.520Z',
  currency: 'BRL',
  payment_id: 'pay-poc-001',
  provider_call_id: 'bf79393f-6e5b-4d38-bcee-0b897333b705',
  provider_commit_id: '0022d46e-4a9d-4997-8022-2d668a7febd3',
  provider_request_id: PROVIDER_REQUEST,
  provider_transaction_id: '45330d17-68f2-490e-a631-e1f052952dda',
  refund_request_id: 'ref-poc-001',
  status: 'SUCCEEDED',
} as const;
/** The late transaction's call, commit and transaction: fresh UUIDv4s. */
const LATE_TRANSACTION = {
  ...FROZEN_TRANSACTION,
  commit_requested_at: '2026-10-05T12:09:00.000Z',
  provider_call_id: '3f8a2c61-7d4e-4b19-9c05-e2a6b8d1f374',
  provider_commit_id: 'e5b8abc6-9fcd-4a7e-9c5a-4d6fbb9ec085',
  provider_transaction_id: 'f6c9bcd7-afde-4b8f-8d6b-5e7acc0fd196',
} as const;

export default defineGoldenCase({
  case_id: 'contradictory',
  ac_ids: ['AC-RUA-030'],
  rule_outcomes_reached: [],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'put_file',
      path: 'late-evidence/late-evidence-stream.jsonl',
      content: {
        kind: 'jsonl',
        records: [
          {
            schema_version: 1,
            record_type: 'late_evidence_record',
            run_id: RUN,
            execution_manifest_sha256: '@sha256(admission/execution-manifest.json)',
            trial_id: TRIAL,
            trial_manifest_sha256: '@sha256($trial/trial-manifest.json)',
            sequence: 1,
            captured_at: '2026-10-05T13:40:00.000Z',
            late_source: 'LEDGER',
            correlated: true,
            late_record_type: 'ledger_snapshot',
            late_record: {
              schema_version: 1,
              record_type: 'ledger_snapshot',
              run_id: RUN,
              execution_manifest_sha256: '@sha256(admission/execution-manifest.json)',
              trial_id: TRIAL,
              trial_manifest_sha256: '@sha256($trial/trial-manifest.json)',
              writer: 'evidence_collector',
              partition_key: `${RUN}#${TRIAL}`,
              consistent_read: true,
              captured_at: '2026-10-05T13:40:00.000Z',
              complete: true,
              pages: [{ page_number: 1, item_count: 2 }],
              transactions: [FROZEN_TRANSACTION, LATE_TRANSACTION],
            },
          },
        ],
      },
    },
  ],
  expected: {
    late_evidence_status: 'contradictory',
    monitoring: 'complete',
    correlated_record_count: 1,
    reassessments: [
      {
        trial: '$trial',
        status: 'contradictory',
        changes: [
          '/preservation_verdict: "pass" -> "fail"',
          '/rule_results/0/result: "pass" -> "fail"',
          '/rule_results/1/result: "pass" -> "fail"',
          '/rule_results/7/result: "pass" -> "fail"',
          '/correct_completion: true -> false',
        ],
      },
    ],
    reason_codes: [],
    frozen_result_unchanged: true,
    late_stream_referenced: true,
    late_evidence_acceptable: false,
  },
});
