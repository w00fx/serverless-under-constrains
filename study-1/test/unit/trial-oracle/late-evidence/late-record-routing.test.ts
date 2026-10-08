// Where a correlated late record joins the frozen evidence (design §7 layout): journal events and
// queue observations become lines of their source's file, re-captured documents fold into their
// frozen copy, and the execution-level files are shared by every trial's evidence.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import type { LateEvidenceRecord } from '../../../../src/record-contract/records/group-c/late_evidence_record.ts';
import type { LateEvidenceSource } from '../../../../src/record-contract/records/group-c/vocabulary.ts';
import { routeLateRecord } from '../../../../src/trial-oracle/late-evidence/late-record-routing.ts';

const TRIAL = '1549b47d-5c04-4f8c-98f1-789a4dc2eda2';
const TRIAL_DIRECTORY = `trials/${TRIAL}`;

function record(source: LateEvidenceSource, type: string, trialScoped: boolean): LateEvidenceRecord {
  const value: JsonObject = {
    schema_version: 1,
    record_type: 'late_evidence_record',
    run_id: 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4',
    execution_manifest_sha256: 'a'.repeat(64),
    ...(trialScoped ? { trial_id: TRIAL, trial_manifest_sha256: 'b'.repeat(64) } : {}),
    sequence: 1,
    captured_at: '2026-10-05T13:40:00.000Z',
    late_source: source,
    correlated: true,
    late_record_type: type,
    late_record: { schema_version: 1, record_type: type },
  };
  return value as unknown as LateEvidenceRecord;
}

describe('routeLateRecord', () => {
  it('appends trial journal events to the trial journal of their source', () => {
    assert.deepEqual(routeLateRecord(record('CALLER_JOURNAL', 'attempt_registered', true)), {
      path: `${TRIAL_DIRECTORY}/journals/caller-journal.jsonl`,
      fold: 'append_line',
      shared: false,
    });
    assert.deepEqual(routeLateRecord(record('PROVIDER_JOURNAL', 'provider_call_received', true)), {
      path: `${TRIAL_DIRECTORY}/journals/provider-journal.jsonl`,
      fold: 'append_line',
      shared: false,
    });
    assert.deepEqual(routeLateRecord(record('CONTROLLER_JOURNAL', 'timeout_signal_duplicate_observed', true)), {
      path: `${TRIAL_DIRECTORY}/journals/controller-journal.jsonl`,
      fold: 'append_line',
      shared: false,
    });
  });

  it('appends a trial runner event to the one shared runner journal', () => {
    assert.deepEqual(routeLateRecord(record('RUNNER_JOURNAL', 'treatment_armed', true)), {
      path: 'runner/runner-journal.jsonl',
      fold: 'append_line',
      shared: true,
    });
  });

  it('appends queue observations to the source or DLQ observation stream', () => {
    assert.deepEqual(routeLateRecord(record('SOURCE_QUEUE', 'queue_observation', true)), {
      path: `${TRIAL_DIRECTORY}/queues/source-observations.jsonl`,
      fold: 'append_line',
      shared: false,
    });
    assert.deepEqual(routeLateRecord(record('DLQ', 'queue_observation', true)), {
      path: `${TRIAL_DIRECTORY}/queues/dlq-observations.jsonl`,
      fold: 'append_line',
      shared: false,
    });
  });

  it('folds re-captured documents into their frozen copy', () => {
    assert.deepEqual(routeLateRecord(record('LEDGER', 'ledger_snapshot', true)), {
      path: `${TRIAL_DIRECTORY}/ledger/ledger-snapshot.json`,
      fold: 'ledger_transactions',
      shared: false,
    });
    assert.deepEqual(routeLateRecord(record('DLQ', 'dlq_snapshot', true)), {
      path: `${TRIAL_DIRECTORY}/queues/dlq-snapshot.json`,
      fold: 'dlq_messages',
      shared: false,
    });
    assert.deepEqual(routeLateRecord(record('DURABLE_EXECUTION_METADATA', 'durable_execution_metadata', true)), {
      path: `${TRIAL_DIRECTORY}/execution-metadata/durable-executions.json`,
      fold: 'durable_executions',
      shared: false,
    });
  });

  it('places execution-level events in the runner journal or the execution provider partition', () => {
    assert.deepEqual(routeLateRecord(record('RUNNER_JOURNAL', 'phase_transition_recorded', false)), {
      path: 'runner/runner-journal.jsonl',
      fold: 'append_line',
      shared: true,
    });
    assert.deepEqual(routeLateRecord(record('PROVIDER_JOURNAL', 'provider_call_received', false)), {
      path: 'provider/provider-journal.jsonl',
      fold: 'append_line',
      shared: true,
    });
  });

  it('has no place for a record its source cannot produce or its scope cannot hold', () => {
    assert.equal(routeLateRecord(record('CALLER_JOURNAL', 'attempt_registered', false)), undefined);
    assert.equal(routeLateRecord(record('LEDGER', 'ledger_snapshot', false)), undefined);
    assert.equal(routeLateRecord(record('LEDGER', 'provider_call_received', true)), undefined);
    assert.equal(routeLateRecord(record('CALLER_JOURNAL', 'ledger_snapshot', true)), undefined);
    assert.equal(routeLateRecord(record('CALLER_JOURNAL', 'not_a_record_type', true)), undefined);
    assert.equal(routeLateRecord(record('RUNNER_JOURNAL', 'not_a_record_type', false)), undefined);
  });
});
