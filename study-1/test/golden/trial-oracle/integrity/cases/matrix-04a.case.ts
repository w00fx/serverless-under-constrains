// BR-RUA-029 matrix row 4, case a: "Invalid or unverified treatment with two observed transactions
// -> indeterminate with rule failures reported, null". The conventional treatment trial, plus a
// `timeout_signal_conflict_recorded`: the redelivered attempt's caller event tried the transition
// the first attempt's timeout already took. Conflicting control evidence makes treatment fidelity
// `invalid` (BR-RUA-025), so the trial is invalid; the ledger basis is still conclusive, so the two
// transactions are reported as rule failures (design D-15).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const CONTROLLER_JOURNAL = '$trial/journals/controller-journal.jsonl';
/** The treatment trial's identities, as the builder derives them. */
const RUN = 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4';
const TRIAL = '1549b47d-5c04-4f8c-98f1-789a4dc2eda2';
const CONTROLLER_INSTANCE = '470ff89a-9b44-4503-864c-bb575ae1a56e';
/** The first attempt's caller timeout, which the recorded signal already names. */
const SIGNALLED_TIMEOUT = '62217f84-74ca-429e-81f4-6f8b8004194d';
/** The redelivered attempt and its dispatch: the conflicting caller event. */
const SECOND_ATTEMPT = '187da39c-2b00-4aa1-9e4d-b3d17ba71c5e';
const SECOND_DISPATCH = '0f2c19d2-a9bd-499a-a855-248b52d1b21e';
/** The conflict event: a fresh UUIDv4. */
const CONFLICT = '5c8e2a71-3d94-4b06-9f1e-a2b7c4d6e830';

export default defineGoldenCase({
  case_id: 'matrix-04a',
  ac_ids: ['AC-RUA-055'],
  rule_outcomes_reached: [
    { rule_id: 'treatment_fidelity', outcome: 'invalid' },
    { rule_id: 'BR-RUA-001', outcome: 'fail' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-treatment',
  operations: [
    {
      op: 'insert_record',
      path: CONTROLLER_JOURNAL,
      after: { record_type: 'timeout_signal_recorded' },
      record: {
        schema_version: 1,
        record_type: 'timeout_signal_conflict_recorded',
        event_id: CONFLICT,
        run_id: RUN,
        execution_manifest_sha256: '@sha256(admission/execution-manifest.json)',
        trial_id: TRIAL,
        trial_manifest_sha256: '@sha256($trial/trial-manifest.json)',
        source: 'treatment_controller',
        source_instance_id: CONTROLLER_INSTANCE,
        source_sequence: 2,
        occurred_at: '2026-10-05T12:36:05.850Z',
        causation_event_ids: [SECOND_DISPATCH],
        caller_timeout_event_id: SECOND_DISPATCH,
        existing_caller_event_id: SIGNALLED_TIMEOUT,
        attempt_id: SECOND_ATTEMPT,
        treatment_state: 'RESPONSE_RELEASED',
      },
    },
    { op: 'resequence', path: CONTROLLER_JOURNAL },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    gates: { treatment_fidelity: 'invalid' },
    rules: { 'BR-RUA-001': 'fail', 'BR-RUA-002': 'fail', 'BR-RUA-009': 'fail' },
    monetary_observations: { successful_transaction_count: 2, refunded_total_minor: '20000', ledger_complete: true },
  },
});
