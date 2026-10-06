// AC-RUA-030 case 1 (BR-RUA-031, BR-RUA-043, D-16): consistent late evidence. After the run's
// final freeze, complete monitoring of 15 minutes (BR-RUA-043 "at least 120 seconds") observes one
// correlated record: the treatment controller sees the targeted timeout signal delivered again
// and records a `timeout_signal_duplicate_observed`, a diagnostic (BR-RUA-025). Re-evaluating the
// treatment trial with it leaves the verdict projection unchanged, so the late evidence is
// `consistent` (design §8.13), it is preserved in the late stream, the frozen result and digests stay
// unchanged, and comparison is not blocked.

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';
import type { LateMonitoring } from '../../../../../src/trial-oracle/late-evidence/late-evidence-input.ts';
import type { UtcMillis } from '../../../../../src/record-contract/primitives.ts';

/** How late monitoring ended for this case (read by the late-evidence golden). */
export const monitoring: LateMonitoring = {
  outcome: 'complete',
  started_at: '2026-10-05T13:30:00.000Z' as UtcMillis,
  ended_at: '2026-10-05T13:45:00.000Z' as UtcMillis,
};

/** The treatment trial's run, attempt, controller and recorded signal, as the builder derives them. */
const RUN = 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4';
const ATTEMPT = '8a8ac4ce-bc55-458a-9f73-d3428ea0492a';
const CALLER_TIMEOUT = '62217f84-74ca-429e-81f4-6f8b8004194d';
const CONTROLLER_INSTANCE = '470ff89a-9b44-4503-864c-bb575ae1a56e';
const SIGNAL_RECORDED = '051a7d09-84f5-4f31-80e2-be806374fdee';
const TRIAL = '1549b47d-5c04-4f8c-98f1-789a4dc2eda2';
/** The duplicate observation: a fresh UUIDv4. */
const DUPLICATE = '9b2d4f6a-8c1e-4a3b-9d5f-7e0a2c4b6d81';

export default defineGoldenCase({
  case_id: 'consistent',
  ac_ids: ['AC-RUA-030'],
  rule_outcomes_reached: [],
  base: 'run-conventional-treatment',
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
            late_source: 'CONTROLLER_JOURNAL',
            correlated: true,
            late_record_type: 'timeout_signal_duplicate_observed',
            late_record: {
              schema_version: 1,
              record_type: 'timeout_signal_duplicate_observed',
              event_id: DUPLICATE,
              run_id: RUN,
              execution_manifest_sha256: '@sha256(admission/execution-manifest.json)',
              trial_id: TRIAL,
              trial_manifest_sha256: '@sha256($trial/trial-manifest.json)',
              source: 'treatment_controller',
              source_instance_id: CONTROLLER_INSTANCE,
              source_sequence: 2,
              occurred_at: '2026-10-05T13:40:00.000Z',
              causation_event_ids: [SIGNAL_RECORDED],
              caller_timeout_event_id: CALLER_TIMEOUT,
              attempt_id: ATTEMPT,
              treatment_state: 'TIMEOUT_SIGNALLED',
            },
          },
        ],
      },
    },
  ],
  expected: {
    late_evidence_status: 'consistent',
    monitoring: 'complete',
    correlated_record_count: 1,
    reassessments: [{ trial: '$trial', status: 'consistent', changes: [] }],
    frozen_result_unchanged: true,
    late_evidence_acceptable: true,
  },
});
