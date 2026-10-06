// The late-evidence assessment of one execution (BR-RUA-043, D-16, AC-RUA-030): none without
// correlated late records, consistent when every re-evaluation keeps its verdict projection,
// contradictory when one changes, unverified when monitoring was shortened, skipped or failed; the
// frozen results and their bytes are only read; input it cannot assess is refused with reasons.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type { LateEvidenceAssessment } from '../../../../src/record-contract/records/group-c/late_evidence_assessment.ts';
import { assessLateEvidence } from '../../../../src/trial-oracle/late-evidence/assess-late-evidence.ts';
import type { LateEvidenceInput } from '../../../../src/trial-oracle/late-evidence/late-evidence-input.ts';
import { ORACLE_VALIDATOR } from '../support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT } from '../support/trial-plans.ts';
import {
  STREAM_PATH,
  duplicateSignal,
  frozenFixture,
  lateInput,
  lateLedger,
  lateRecord,
  lateStream,
  lateStreamText,
  firstOf,
  refusalOf,
} from './support/late-fixtures.ts';

const control = frozenFixture(CONVENTIONAL_CONTROL);
const treatment = frozenFixture(CONVENTIONAL_TREATMENT);
const validation = frozenFixture({ base: 'validation-conventional-control' });
const OTHER_ID = '6f1d3b5a-7c9e-4b2d-8f4a-1c3e5a7b9d02';
const START = '2026-10-05T13:30:00.000Z' as UtcMillis;
const SHORT_END = '2026-10-05T13:31:00.000Z' as UtcMillis;

const ledgerLine = (sequence = 1): JsonValue =>
  lateRecord(control, { sequence, late_source: 'LEDGER', late_record: lateLedger(control, 1) });
const signalLine = (sequence = 1): JsonValue =>
  lateRecord(treatment, { sequence, late_source: 'CONTROLLER_JOURNAL', late_record: duplicateSignal(treatment) });

function assessed(input: LateEvidenceInput): LateEvidenceAssessment {
  const assessment = assessLateEvidence(input, ORACLE_VALIDATOR);
  if (!assessment.ok) {
    throw new Error(`the assessment was refused: ${JSON.stringify(assessment.error)}; expected an assessment`);
  }
  return assessment.value;
}

function refusalCodes(input: LateEvidenceInput): readonly string[] {
  const assessment = assessLateEvidence(input, ORACLE_VALIDATOR);
  return assessment.ok ? [] : assessment.error.map((reason) => reason.code);
}

const statuses = (assessment: LateEvidenceAssessment): readonly string[] =>
  assessment.reassessments.map((reassessment) => reassessment.status);

describe('assessLateEvidence', () => {
  it('is none when monitoring completed without a correlated late record', () => {
    const stream = lateStream([]);
    const assessment = assessed(lateInput([control, treatment], stream));
    assert.deepEqual(
      {
        monitoring: assessment.monitoring,
        status: assessment.late_evidence_status,
        count: assessment.correlated_record_count,
        reasons: assessment.reasons,
        refs: assessment.evidence_refs,
        started: assessment.monitoring_started_at,
        ended: assessment.monitoring_ended_at,
        run_id: (assessment as unknown as JsonObject)['run_id'],
        assessed_at: assessment.assessed_at,
      },
      {
        monitoring: 'complete',
        status: 'none',
        count: 0,
        reasons: [],
        refs: [{ artifact_path: STREAM_PATH, artifact_sha256: sha256Hex(stream.bytes) }],
        started: '2026-10-05T13:30:00.000Z',
        ended: '2026-10-05T13:45:00.000Z',
        run_id: control.result.run_id,
        assessed_at: '2026-10-05T13:50:00.000Z',
      },
    );
    assert.deepEqual(statuses(assessment), ['none', 'none']);
  });

  it('is consistent when a late duplicate signal leaves every projection as frozen', () => {
    const assessment = assessed(lateInput([control, treatment], lateStream([signalLine()])));
    assert.equal(assessment.late_evidence_status, 'consistent');
    assert.equal(assessment.correlated_record_count, 1);
    assert.deepEqual(statuses(assessment), ['none', 'consistent']);
  });

  it('is contradictory when a late ledger transaction changes the control verdict, frozen bytes untouched', () => {
    const before = control.evidence.result.bytes.slice();
    const assessment = assessed(lateInput([control, treatment], lateStream([ledgerLine(1), signalLine(2)])));
    assert.equal(assessment.late_evidence_status, 'contradictory');
    assert.deepEqual(statuses(assessment), ['contradictory', 'consistent']);
    assert.deepEqual(assessment.reassessments[0]?.frozen_result_ref, {
      artifact_path: control.evidence.result.path,
      artifact_sha256: sha256Hex(before),
    });
    assert.deepEqual(control.evidence.result.bytes, before);
  });

  it('is unverified with the reason when monitoring was declared shortened, skipped or failed', () => {
    const skipped = assessed(lateInput([control], undefined, { outcome: 'skipped' }));
    assert.deepEqual(
      [
        skipped.monitoring,
        skipped.late_evidence_status,
        skipped.reasons.map((reason) => reason.code),
        skipped.evidence_refs,
      ],
      ['skipped', 'unverified', ['MONITORING_SKIPPED'], []],
    );
    assert.equal(Object.hasOwn(skipped, 'monitoring_started_at'), false);
    assert.deepEqual(statuses(skipped), ['unverified']);

    const shortened = assessed(
      lateInput([control], lateStream([]), { outcome: 'shortened', started_at: START, ended_at: SHORT_END }),
    );
    assert.deepEqual([shortened.monitoring, shortened.monitoring_ended_at], ['shortened', SHORT_END]);

    const failed = assessed(lateInput([control], lateStream([]), { outcome: 'failed', started_at: START }));
    assert.deepEqual(
      [failed.monitoring, failed.monitoring_started_at, failed.monitoring_ended_at],
      ['failed', START, undefined],
    );
  });

  it('keeps a change found after incomplete monitoring contradictory while the execution stays unverified', () => {
    const assessment = assessed(
      lateInput([control], lateStream([ledgerLine()]), { outcome: 'shortened', started_at: START }),
    );
    assert.equal(assessment.late_evidence_status, 'unverified');
    assert.deepEqual(statuses(assessment), ['contradictory']);
  });

  it('is shortened when a declared complete window lasted less than 120 s', () => {
    const assessment = assessed(
      lateInput([control], lateStream([]), { outcome: 'complete', started_at: START, ended_at: SHORT_END }),
    );
    assert.equal(assessment.monitoring, 'shortened');
    assert.deepEqual(
      assessment.reasons.map((reason) => reason.code),
      ['MONITORING_WINDOW_SHORT'],
    );
  });

  it('fails when a monitoring left no stream or an unreadable one', () => {
    const missing = assessed(lateInput([control], undefined));
    assert.deepEqual(
      [missing.monitoring, missing.reasons.map((reason) => reason.code)],
      ['failed', ['LATE_STREAM_MISSING']],
    );
    assert.equal(missing.reasons[0]?.artifact_path, STREAM_PATH);

    const unreadable = assessed(lateInput([control, treatment], lateStreamText('not json\n')));
    assert.deepEqual([unreadable.monitoring, unreadable.late_evidence_status], ['failed', 'unverified']);
    assert.deepEqual(
      unreadable.reasons.map((reason) => reason.code),
      ['LATE_RECORD_UNREADABLE'],
    );

    const shortenedWithoutStream = assessed(lateInput([control], undefined, { outcome: 'shortened' }));
    assert.deepEqual(
      shortenedWithoutStream.reasons.map((reason) => reason.code),
      ['MONITORING_SHORTENED', 'LATE_STREAM_MISSING'],
    );
  });

  it('counts a record of a trial without a frozen result and says so', () => {
    const orphan = lateRecord(control, {
      sequence: 1,
      late_source: 'LEDGER',
      late_record: { ...lateLedger(control, 1), trial_id: OTHER_ID },
    });
    const line = { ...orphan, trial_id: OTHER_ID };
    const assessment = assessed(lateInput([control], lateStream([line, { ...line, sequence: 2 }])));
    assert.deepEqual(
      [assessment.late_evidence_status, assessment.correlated_record_count, statuses(assessment)],
      ['consistent', 2, ['none']],
    );
    assert.deepEqual(
      assessment.reasons.map((reason) => [reason.code, reason.artifact_path]),
      [['LATE_RECORD_WITHOUT_FROZEN_RESULT', STREAM_PATH]],
    );
    assert.match(
      assessment.reasons[0]?.detail ?? '',
      /line 1 names trial .*, which has no frozen result.*\(and 1 more\)$/,
    );
  });

  it('assesses a variant validation under its own identity', () => {
    const validationId = validation.result.variant_validation_id;
    assert.ok(validationId !== undefined);
    const input: LateEvidenceInput = {
      ...lateInput([control], lateStream([])),
      execution: { variant_validation_id: validationId },
      execution_manifest_sha256: validation.result.execution_manifest_sha256,
      trials: [validation.evidence],
    };
    const assessment = assessed(input);
    assert.equal(
      (assessment as unknown as JsonObject)['variant_validation_id'],
      validation.result.variant_validation_id,
    );
    assert.equal(Object.hasOwn(assessment, 'run_id'), false);
  });

  it('refuses a malformed monitoring window, a misplaced stream and an unreadable frozen result', () => {
    assert.deepEqual(
      refusalCodes(
        lateInput([control], lateStream([]), { outcome: 'complete', started_at: SHORT_END, ended_at: START }),
      ),
      ['MONITORING_WINDOW_INVALID'],
    );
    const misplaced = {
      ...lateInput([control], undefined),
      stream: { path: 'late/stream.jsonl', bytes: new Uint8Array() },
    };
    assert.deepEqual(refusalCodes(misplaced), ['LATE_STREAM_MISPLACED']);
    const broken = { frozen: control.frozen, result: { path: control.evidence.result.path, bytes: new Uint8Array() } };
    assert.deepEqual(refusalCodes({ ...lateInput([control], lateStream([])), trials: [broken] }), [
      'FROZEN_RESULT_UNREADABLE',
    ]);
  });

  it('refuses when a trial with late evidence cannot be re-evaluated', () => {
    const manifest = `trials/${control.result.trial_id}/trial-manifest.json`;
    const evidence = {
      ...control.evidence,
      frozen: {
        ...control.frozen,
        artifacts: control.frozen.artifacts.filter((artifact) => artifact.path !== manifest),
      },
    };
    const input = { ...lateInput([control], lateStream([ledgerLine()])), trials: [evidence] };
    assert.deepEqual(refusalCodes(input), ['REEVALUATION_REFUSED']);
  });

  it('refuses input whose assessment would not be a valid record', () => {
    const input = { ...lateInput([control], lateStream([])), assessed_at: 'yesterday' as UtcMillis };
    const assessment = assessLateEvidence(input, ORACLE_VALIDATOR);
    assert.equal(assessment.ok, false);
    assert.deepEqual(
      refusalOf(assessment).map((reason) => [reason.code, reason.subject]),
      [['ASSESSMENT_SCHEMA_INVALID', 'BR-RUA-043']],
    );
    assert.match(firstOf(refusalOf(assessment)).detail, /assessed_at.*; expected a valid late_evidence_assessment$/);
  });

  it('produces assessments that validate against their schema', () => {
    for (const input of [
      lateInput([control, treatment], lateStream([ledgerLine(1), signalLine(2)])),
      lateInput([control], undefined, { outcome: 'skipped' }),
    ]) {
      const validated = ORACLE_VALIDATOR.validateAs(
        'late_evidence_assessment',
        assessed(input) as unknown as JsonValue,
      );
      assert.equal(validated.valid, true);
    }
  });
});
