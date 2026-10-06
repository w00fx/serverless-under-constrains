// Reading the late stream (BR-RUA-043, catalogue group C row 77): correlated records of this
// execution with a place in the frozen evidence are accepted; uncorrelated records are kept but
// ignored; every line that cannot be read so is a late problem naming the line, the offending value
// and the expected shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { activeExecution, readLateStream } from '../../../../src/trial-oracle/late-evidence/late-stream-reading.ts';
import type { LateStreamContext } from '../../../../src/trial-oracle/late-evidence/late-stream-reading.ts';
import { ORACLE_VALIDATOR } from '../support/built-trials.ts';
import { CONVENTIONAL_CONTROL } from '../support/trial-plans.ts';
import {
  frozenFixture,
  lateLedger,
  lateRecord,
  lateStream,
  lateStreamText,
  runIdOf,
  firstOf,
} from './support/late-fixtures.ts';

const control = frozenFixture(CONVENTIONAL_CONTROL);
const OTHER_ID = '6f1d3b5a-7c9e-4b2d-8f4a-1c3e5a7b9d02';
const CONTEXT: LateStreamContext = {
  execution: { run_id: runIdOf(control) },
  execution_manifest_sha256: control.result.execution_manifest_sha256,
  trial_manifests: new Map([[control.result.trial_id, control.result.trial_manifest_sha256]]),
};
const ledgerRecord = (sequence: number, overrides: JsonObject = {}): JsonObject => ({
  ...lateRecord(control, { sequence, late_source: 'LEDGER', late_record: lateLedger(control, 0) }),
  ...overrides,
});

function codesOf(stream: ReturnType<typeof lateStream>, context: LateStreamContext = CONTEXT): readonly string[] {
  return readLateStream(stream, context, ORACLE_VALIDATOR).problems.map((problem) => problem.code);
}

function detailOf(stream: ReturnType<typeof lateStream>, context: LateStreamContext = CONTEXT): string {
  return readLateStream(stream, context, ORACLE_VALIDATOR).problems[0]?.detail ?? '';
}

describe('readLateStream', () => {
  it('reads nothing from an absent or empty stream', () => {
    assert.deepEqual(readLateStream(undefined, CONTEXT, ORACLE_VALIDATOR), { accepted: [], problems: [] });
    assert.deepEqual(readLateStream(lateStream([]), CONTEXT, ORACLE_VALIDATOR), { accepted: [], problems: [] });
  });

  it('accepts a correlated record with its route and line', () => {
    const reading = readLateStream(lateStream([ledgerRecord(1)]), CONTEXT, ORACLE_VALIDATOR);
    assert.deepEqual(reading.problems, []);
    assert.equal(reading.accepted.length, 1);
    const accepted = firstOf(reading.accepted);
    assert.equal(accepted.line_number, 1);
    assert.equal(accepted.record.late_record_type, 'ledger_snapshot');
    assert.deepEqual(accepted.route, {
      path: `trials/${control.result.trial_id}/ledger/ledger-snapshot.json`,
      fold: 'ledger_transactions',
      shared: false,
    });
  });

  it('keeps an uncorrelated record out of reassessment without a problem', () => {
    const uncorrelated = lateRecord(control, {
      sequence: 1,
      late_source: 'RUNNER_JOURNAL',
      late_record: { schema_version: 1, record_type: 'phase_transition_recorded' },
      correlated: false,
      trial_scoped: false,
    });
    assert.deepEqual(readLateStream(lateStream([uncorrelated]), CONTEXT, ORACLE_VALIDATOR), {
      accepted: [],
      problems: [],
    });
  });

  it('accepts a record of a trial that has no frozen result without a manifest check', () => {
    const elsewhere = ledgerRecord(1, {
      trial_id: OTHER_ID,
      trial_manifest_sha256: 'c'.repeat(64),
      late_record: { ...lateLedger(control, 0), trial_id: OTHER_ID, trial_manifest_sha256: 'c'.repeat(64) },
    });
    const reading = readLateStream(lateStream([elsewhere]), CONTEXT, ORACLE_VALIDATOR);
    assert.deepEqual(reading.problems, []);
    assert.equal(reading.accepted[0]?.record.trial_id, OTHER_ID);
  });

  it('reports a stream whose last line has no newline, and still reads that line', () => {
    const stream = lateStreamText(JSON.stringify(ledgerRecord(1)));
    const reading = readLateStream(stream, CONTEXT, ORACLE_VALIDATOR);
    assert.deepEqual(
      reading.problems.map((problem) => [problem.code, problem.artifact_path]),
      [['LATE_STREAM_TRUNCATED', 'late-evidence/late-evidence-stream.jsonl']],
    );
    assert.match(reading.problems[0]?.detail ?? '', /last line \(1\) has no terminating newline/);
    assert.equal(reading.accepted.length, 1);
  });

  it('reports a line that is not JSON or not UTF-8', () => {
    assert.deepEqual(codesOf(lateStreamText('{"sequence":\n')), ['LATE_RECORD_UNREADABLE']);
    assert.match(detailOf(lateStreamText('{"sequence":\n')), /^line 1: .*; expected one UTF-8 JSON object$/);
    const invalidUtf8 = {
      path: 'late-evidence/late-evidence-stream.jsonl',
      bytes: Uint8Array.of(0x7b, 0xc0, 0x80, 0x0a),
    };
    assert.match(detailOf(invalidUtf8), /^line 1: "invalid UTF-8 at byte 1"/);
  });

  it('reports a line that is not a late_evidence_record', () => {
    const stream = lateStream([{ ...ledgerRecord(1), late_source: 'TELEMETRY' }]);
    assert.deepEqual(codesOf(stream), ['LATE_RECORD_SCHEMA_INVALID']);
    assert.match(detailOf(stream), /^line 1: "\/late_source must be equal to one of the allowed values/);
    assert.match(detailOf(stream), /; expected a late_evidence_record$/);
  });

  it('reports a sequence that is not dense from 1', () => {
    const stream = lateStream([ledgerRecord(1), ledgerRecord(3)]);
    assert.deepEqual(codesOf(stream), ['LATE_SEQUENCE_BROKEN']);
    assert.equal(detailOf(stream), 'line 2: sequence 3; expected 2 (dense from 1)');
  });

  it('reports a record or carried record of another execution, manifest or trial', () => {
    const carried = lateLedger(control, 0);
    const cases: readonly [JsonObject, RegExp][] = [
      [ledgerRecord(1, { run_id: OTHER_ID }), /the record names another execution; expected run_id /],
      [ledgerRecord(1, { execution_manifest_sha256: 'd'.repeat(64) }), /the record names execution manifest "d{64}"/],
      [ledgerRecord(1, { late_record: { ...carried, run_id: OTHER_ID } }), /late_record names another execution/],
      [
        ledgerRecord(1, { late_record: { ...carried, execution_manifest_sha256: 'e'.repeat(64) } }),
        /late_record names execution manifest "e{64}"/,
      ],
      [
        ledgerRecord(1, { late_record: { ...carried, trial_id: OTHER_ID } }),
        /late_record names trial ".*"; expected the record's trial/,
      ],
    ];
    for (const [record, detail] of cases) {
      assert.deepEqual(codesOf(lateStream([record])), ['LATE_RECORD_FOREIGN']);
      assert.match(detailOf(lateStream([record])), detail);
    }
  });

  it('accepts a carried record without a trial, and an execution-level record of a trial-less carried record', () => {
    const { trial_id: trialId, trial_manifest_sha256: manifest, ...executionLevel } = lateLedger(control, 0);
    assert.ok(trialId !== undefined && manifest !== undefined);
    const reading = readLateStream(
      lateStream([ledgerRecord(1, { late_record: executionLevel })]),
      CONTEXT,
      ORACLE_VALIDATOR,
    );
    assert.deepEqual(reading.problems, []);
  });

  it('names a variant validation when a run record is foreign to it', () => {
    const validation: LateStreamContext = { ...CONTEXT, execution: { variant_validation_id: OTHER_ID as Uuid4 } };
    assert.match(detailOf(lateStream([ledgerRecord(1)]), validation), /expected variant_validation_id /);
  });

  it('reports a carried record whose record_type is not late_record_type', () => {
    const mismatched = lateStream([ledgerRecord(1, { late_record_type: 'dlq_snapshot' })]);
    assert.deepEqual(codesOf(mismatched), ['LATE_RECORD_TYPE_MISMATCH']);
    assert.match(
      detailOf(mismatched),
      /late_record.record_type is "ledger_snapshot"; expected late_record_type "dlq_snapshot"/,
    );
    const untyped = lateStream([ledgerRecord(1, { late_record: { schema_version: 1, record_type: 7 } })]);
    assert.match(detailOf(untyped), /late_record.record_type is null;/);
  });

  it('reports a carried record that is not a valid record of its own type, and accepts nothing from it', () => {
    const { pages, ...pageless } = lateLedger(control, 0);
    assert.ok(pages !== undefined);
    const stream = lateStream([ledgerRecord(1, { late_record: pageless })]);
    assert.deepEqual(codesOf(stream), ['LATE_RECORD_SCHEMA_INVALID']);
    assert.match(
      detailOf(stream),
      /^line 1: late_record " must have required property 'pages'.*"; expected a valid ledger_snapshot$/,
    );
    assert.deepEqual(readLateStream(stream, CONTEXT, ORACLE_VALIDATOR).accepted, []);
  });

  it('reports a trial record whose trial manifest is not the frozen one', () => {
    const stream = lateStream([ledgerRecord(1, { trial_manifest_sha256: 'f'.repeat(64) })]);
    assert.deepEqual(codesOf(stream), ['LATE_TRIAL_MANIFEST_MISMATCH']);
    assert.match(detailOf(stream), /names trial manifest f{64}; expected the frozen [0-9a-f]{64}/);
  });

  it('reports a record that has no place in the frozen evidence', () => {
    const trialScoped = lateStream([ledgerRecord(1, { late_source: 'CALLER_JOURNAL' })]);
    assert.deepEqual(codesOf(trialScoped), ['LATE_RECORD_UNROUTABLE']);
    assert.match(detailOf(trialScoped), /line 1: trial "ledger_snapshot" from CALLER_JOURNAL has no place/);
    const { trial_id: trialId, trial_manifest_sha256: manifest, ...executionLevel } = ledgerRecord(1);
    assert.ok(trialId !== undefined && manifest !== undefined);
    assert.match(detailOf(lateStream([executionLevel])), /line 1: execution-level "ledger_snapshot" from LEDGER/);
  });

  it('reads every line independently', () => {
    const stream = lateStream([ledgerRecord(1), { broken: true }, ledgerRecord(3)]);
    const reading = readLateStream(stream, CONTEXT, ORACLE_VALIDATOR);
    assert.deepEqual(
      reading.accepted.map((accepted) => accepted.line_number),
      [1, 3],
    );
    assert.deepEqual(
      reading.problems.map((problem) => problem.code),
      ['LATE_RECORD_SCHEMA_INVALID'],
    );
  });
});

describe('activeExecution', () => {
  it('names the run or the variant validation', () => {
    const id = OTHER_ID as Uuid4;
    assert.deepEqual(activeExecution({ run_id: id }), { execution_kind: 'RUN', run_id: id });
    assert.deepEqual(activeExecution({ variant_validation_id: id }), {
      execution_kind: 'VARIANT_VALIDATION',
      variant_validation_id: id,
    });
  });
});
