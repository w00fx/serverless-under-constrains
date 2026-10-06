// Reassessing one frozen trial (design §8.13, D-16): only late records that name the trial, or no
// trial, are its late evidence; with them the frozen evidence plus the late records is re-evaluated
// and compared on the verdict projection; the status follows from the changes and the monitoring.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { IngestionInput } from '../../../../src/evidence-ingestion/ingestion-model.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import type { JsonObject } from '../../../../src/record-contract/primitives.ts';
import type { LateEvidenceRecord } from '../../../../src/record-contract/records/group-c/late_evidence_record.ts';
import type { FrozenTrial } from '../../../../src/trial-oracle/late-evidence/frozen-results.ts';
import type { LateRoute } from '../../../../src/trial-oracle/late-evidence/late-record-routing.ts';
import type { AcceptedLateRecord } from '../../../../src/trial-oracle/late-evidence/late-stream-reading.ts';
import { reassessmentOf, reevaluateTrial } from '../../../../src/trial-oracle/late-evidence/trial-reassessment.ts';
import type { TrialReevaluation } from '../../../../src/trial-oracle/late-evidence/trial-reassessment.ts';
import { ORACLE_VALIDATOR } from '../support/built-trials.ts';
import { CONVENTIONAL_CONTROL, CONVENTIONAL_TREATMENT } from '../support/trial-plans.ts';
import {
  ASSESSED_AT,
  duplicateSignal,
  frozenFixture,
  lateLedger,
  lateRecord,
  firstOf,
  refusalOf,
} from './support/late-fixtures.ts';
import type { FrozenFixture } from './support/late-fixtures.ts';

const encoder = new TextEncoder();
const control = frozenFixture(CONVENTIONAL_CONTROL);
const treatment = frozenFixture(CONVENTIONAL_TREATMENT);
const RUNNER = 'runner/runner-journal.jsonl';

function frozenTrial(fixture: FrozenFixture, frozen: IngestionInput = fixture.frozen): FrozenTrial {
  const { path, bytes } = fixture.evidence.result;
  return { frozen, result: fixture.result, result_ref: { artifact_path: path, artifact_sha256: sha256Hex(bytes) } };
}

function accepted(record: JsonObject, route: LateRoute): AcceptedLateRecord {
  return { record: record as unknown as LateEvidenceRecord, route, line_number: 1 };
}

const lateLedgerOf = (fixture: FrozenFixture, extra: 0 | 1): AcceptedLateRecord =>
  accepted(lateRecord(fixture, { sequence: 1, late_source: 'LEDGER', late_record: lateLedger(fixture, extra) }), {
    path: `trials/${fixture.result.trial_id}/ledger/ledger-snapshot.json`,
    fold: 'ledger_transactions',
    shared: false,
  });

const lateSignal = (): AcceptedLateRecord =>
  accepted(
    lateRecord(treatment, { sequence: 1, late_source: 'CONTROLLER_JOURNAL', late_record: duplicateSignal(treatment) }),
    {
      path: `trials/${treatment.result.trial_id}/journals/controller-journal.jsonl`,
      fold: 'append_line',
      shared: false,
    },
  );

describe('reevaluateTrial', () => {
  it('does not re-evaluate a trial that no late record names', () => {
    const otherTrialRunner = accepted(
      lateRecord(treatment, { sequence: 1, late_source: 'RUNNER_JOURNAL', late_record: duplicateSignal(treatment) }),
      { path: RUNNER, fold: 'append_line', shared: true },
    );
    const reevaluation = reevaluateTrial(
      frozenTrial(control),
      [lateLedgerOf(treatment, 1), otherTrialRunner],
      ASSESSED_AT,
      ORACLE_VALIDATOR,
    );
    assert.ok(reevaluation.ok);
    assert.deepEqual(
      {
        counted: reevaluation.value.counted,
        changes: reevaluation.value.changes,
        problems: reevaluation.value.problems,
      },
      { counted: 0, changes: [], problems: [] },
    );
  });

  it('finds no change when a late duplicate signal leaves the projection as frozen', () => {
    const reevaluation = reevaluateTrial(frozenTrial(treatment), [lateSignal()], ASSESSED_AT, ORACLE_VALIDATOR);
    assert.ok(reevaluation.ok);
    assert.equal(reevaluation.value.counted, 1);
    assert.deepEqual(reevaluation.value.changes, []);
  });

  it('finds the changed fields when a late ledger transaction contradicts the frozen pass', () => {
    const reevaluation = reevaluateTrial(
      frozenTrial(control),
      [lateLedgerOf(control, 1)],
      ASSESSED_AT,
      ORACLE_VALIDATOR,
    );
    assert.ok(reevaluation.ok);
    assert.deepEqual(reevaluation.value.changes[0], {
      field: '/preservation_verdict',
      frozen: 'pass',
      reassessed: 'fail',
    });
    assert.deepEqual(reevaluation.value.changes.at(-1), {
      field: '/correct_completion',
      frozen: true,
      reassessed: false,
    });
  });

  it('counts an execution-level record as late evidence of every trial', () => {
    const executionLevel = lateRecord(control, {
      sequence: 1,
      late_source: 'RUNNER_JOURNAL',
      late_record: { schema_version: 1, record_type: 'phase_transition_recorded' },
      trial_scoped: false,
    });
    const reevaluation = reevaluateTrial(
      frozenTrial(control),
      [accepted(executionLevel, { path: RUNNER, fold: 'append_line', shared: true })],
      ASSESSED_AT,
      ORACLE_VALIDATOR,
    );
    assert.ok(reevaluation.ok);
    assert.equal(reevaluation.value.counted, 1);
  });

  it('carries the problems of records that could not join the frozen evidence', () => {
    const controller = `trials/${treatment.result.trial_id}/journals/controller-journal.jsonl`;
    const truncated: IngestionInput = {
      ...treatment.frozen,
      artifacts: treatment.frozen.artifacts.map((artifact) =>
        artifact.path === controller ? { path: controller, bytes: encoder.encode('{}') } : artifact,
      ),
    };
    const reevaluation = reevaluateTrial(
      frozenTrial(treatment, truncated),
      [lateSignal()],
      ASSESSED_AT,
      ORACLE_VALIDATOR,
    );
    assert.ok(reevaluation.ok);
    assert.deepEqual(
      reevaluation.value.problems.map((problem) => problem.code),
      ['LATE_DOCUMENT_UNFOLDABLE'],
    );
  });

  it('refuses when the frozen evidence cannot be evaluated', () => {
    const manifest = `trials/${control.result.trial_id}/trial-manifest.json`;
    const withoutManifest: IngestionInput = {
      ...control.frozen,
      artifacts: control.frozen.artifacts.filter((artifact) => artifact.path !== manifest),
    };
    const reevaluation = reevaluateTrial(
      frozenTrial(control, withoutManifest),
      [lateLedgerOf(control, 1)],
      ASSESSED_AT,
      ORACLE_VALIDATOR,
    );
    assert.equal(reevaluation.ok, false);
    assert.deepEqual(
      refusalOf(reevaluation).map((reason) => [reason.code, reason.subject, reason.artifact_path]),
      [['REEVALUATION_REFUSED', 'BR-RUA-043', control.evidence.result.path]],
    );
    assert.match(firstOf(refusalOf(reevaluation)).detail, /^TRIAL_UNKNOWN: /);
  });

  it('refuses when the frozen evidence is of another trial than the frozen result', () => {
    const mixed = frozenTrial(control, treatment.frozen);
    const reevaluation = reevaluateTrial(mixed, [lateLedgerOf(control, 1)], ASSESSED_AT, ORACLE_VALIDATOR);
    assert.equal(reevaluation.ok, false);
    assert.deepEqual(
      refusalOf(reevaluation).map((reason) => reason.code),
      ['REEVALUATION_TRIAL_MISMATCH'],
    );
    assert.match(
      firstOf(refusalOf(reevaluation)).detail,
      new RegExp(`names trial ${treatment.result.trial_id}; expected trial ${control.result.trial_id}`),
    );
  });
});

describe('reassessmentOf', () => {
  const change = { field: '/preservation_verdict', frozen: 'pass', reassessed: 'fail' } as const;
  const reevaluation = (counted: number, changed: boolean): TrialReevaluation => ({
    trial: frozenTrial(control),
    counted,
    changes: changed ? [change] : [],
    problems: [],
  });

  it('references the frozen result and its trial', () => {
    assert.deepEqual(reassessmentOf(reevaluation(0, false), true), {
      frozen_result_ref: frozenTrial(control).result_ref,
      trial_id: control.result.trial_id,
      status: 'none',
      changes: [],
    });
  });

  it('is none, consistent or contradictory after complete monitoring', () => {
    assert.equal(reassessmentOf(reevaluation(0, false), true).status, 'none');
    assert.equal(reassessmentOf(reevaluation(2, false), true).status, 'consistent');
    assert.equal(reassessmentOf(reevaluation(2, true), true).status, 'contradictory');
  });

  it('is unverified after incomplete monitoring unless a change was still found', () => {
    assert.equal(reassessmentOf(reevaluation(0, false), false).status, 'unverified');
    assert.equal(reassessmentOf(reevaluation(2, false), false).status, 'unverified');
    assert.equal(reassessmentOf(reevaluation(2, true), false).status, 'contradictory');
  });
});
