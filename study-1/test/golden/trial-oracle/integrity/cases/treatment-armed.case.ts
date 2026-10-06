// AC-RUA-029 case 1 (BR-RUA-006, BR-RUA-025): "treatment armed" in a CONTROL trial. The runner
// arms treatment for the control trial's partition before publishing its message, as it does only
// for a treatment trial. Proven treatment activity makes control integrity `invalid`, so the trial
// is invalid and preservation `indeterminate` (BR-RUA-029).

import { defineGoldenCase } from '../../../../support/golden-builder/golden-case.ts';

const RUNNER_JOURNAL = 'runner/runner-journal.jsonl';
/** The control trial and the runner, as the builder derives them. */
const RUN = 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4';
const TRIAL = 'd1d0a2b9-d331-4919-a5e0-44819414b6e9';
const RUNNER_INSTANCE = '14f07508-d729-44a9-9316-85ec257e833b';
/** The arming event: a fresh UUIDv4. */
const ARMED = '7e3a1c95-4b2d-4f68-8a07-c9d5e1b3f246';

export default defineGoldenCase({
  case_id: 'treatment-armed',
  ac_ids: ['AC-RUA-029'],
  rule_outcomes_reached: [
    { rule_id: 'control_integrity', outcome: 'invalid' },
    { rule_id: 'BR-RUA-029', outcome: 'invalid' },
    { rule_id: 'BR-RUA-006', outcome: 'indeterminate' },
    { rule_id: 'BR-RUA-030', outcome: 'null' },
  ],
  base: 'run-conventional-control',
  operations: [
    {
      op: 'insert_record',
      path: RUNNER_JOURNAL,
      after: { record_type: 'trial_partitions_verified_absent' },
      record: {
        schema_version: 1,
        record_type: 'treatment_armed',
        event_id: ARMED,
        run_id: RUN,
        execution_manifest_sha256: '@sha256(admission/execution-manifest.json)',
        trial_id: TRIAL,
        trial_manifest_sha256: '@sha256($trial/trial-manifest.json)',
        source: 'runner',
        source_instance_id: RUNNER_INSTANCE,
        source_sequence: 6,
        occurred_at: '2026-10-05T12:05:02.000Z',
        partition_key: `${RUN}#${TRIAL}`,
        treatment_state: 'ARMED',
        treatment_version: 1,
      },
    },
    { op: 'resequence', path: RUNNER_JOURNAL },
  ],
  expected: {
    preservation_verdict: 'indeterminate',
    trial_validity: 'invalid',
    correct_completion: null,
    control_integrity: 'invalid',
    gates: { control_integrity: 'invalid' },
    gate_reason_codes: { control_integrity: ['TREATMENT_ACTIVITY'] },
  },
});
