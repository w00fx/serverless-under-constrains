// Control integrity, gate G4a (BR-RUA-025, design §8.3, AC-RUA-029): a CONTROL trial whose
// configuration declares CONTROL, with no treatment item, activity or timeout, and a conclusive
// outcome for every accepted call; not applicable to a treatment trial or the probe.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateAssessment } from '../../../src/evidence-ingestion/ingestion-model.ts';
import { deriveControlIntegrity } from '../../../src/treatment-fidelity/control-integrity.ts';
import {
  deleteOp,
  documentOp,
  PROBE_IDS,
  probeEvidence,
  setOp,
  SUBJECT_FILES,
  trialEvidence,
} from './support/treatment-evidence.ts';
import type { ScenarioOperation } from '../../support/golden-builder/operation-parsing.ts';
import type { TrialPlan } from '../../support/golden-builder/golden-plan.ts';
import { codes } from './support/view-edits.ts';

const CONTROL = 'run-conventional-control';

/** A treatment item in the control partition. */
const TREATMENT_ITEM = {
  commit_event_id: PROBE_IDS.commit_event,
  provider_call_id: PROBE_IDS.call,
  provider_commit_id: PROBE_IDS.commit,
  provider_request_id: '58ae07f2-4809-4e4c-9659-f16beb4cfb68',
  provider_transaction_id: PROBE_IDS.transaction,
  state: 'COMMITTED_WAITING',
  targeted_attempt_id: PROBE_IDS.attempt,
  version: 2,
};

function gate(operations: readonly ScenarioOperation[] = [], plan?: TrialPlan): GateAssessment<'control_integrity'> {
  return deriveControlIntegrity(trialEvidence(CONTROL, operations, plan));
}

describe('deriveControlIntegrity', () => {
  it('is verified for both control bases, citing the four artifacts', () => {
    for (const base of ['run-conventional-control', 'run-durable-control'] as const) {
      const assessment = deriveControlIntegrity(trialEvidence(base));
      assert.equal(assessment.value, 'verified', base);
      assert.equal(assessment.evidence_refs.length, 4, base);
    }
  });

  it('is verified for a rejected control call', () => {
    const rejected: TrialPlan = { deliveries: [{ attempts: [{ behavior: 'rejected' }] }], processing: 'completes' };
    assert.equal(gate([], rejected).value, 'verified');
  });

  it('is not applicable to the probe or a COMMIT_THEN_TIMEOUT trial', () => {
    const notApplicable = { gate: 'control_integrity', value: 'not_applicable', reasons: [], evidence_refs: [] };
    assert.deepEqual(deriveControlIntegrity(probeEvidence()), notApplicable);
    assert.deepEqual(deriveControlIntegrity(trialEvidence('run-durable-treatment')), notApplicable);
  });

  it('is invalid with CONTROL_SCENARIO_MISMATCH when the configuration declares a treatment', () => {
    const assessment = gate([documentOp(SUBJECT_FILES.configuration, '/scenario', 'COMMIT_THEN_TIMEOUT')]);
    assert.equal(assessment.value, 'invalid');
    assert.deepEqual(codes(assessment.reasons), ['CONTROL_SCENARIO_MISMATCH']);
  });

  it('is invalid with TREATMENT_ITEM_PRESENT when the partition holds a treatment item', () => {
    const assessment = gate([
      documentOp(SUBJECT_FILES.snapshot, '/item_present', true),
      documentOp(SUBJECT_FILES.snapshot, '/treatment', TREATMENT_ITEM),
    ]);
    assert.equal(assessment.value, 'invalid');
    assert.deepEqual(codes(assessment.reasons), ['TREATMENT_ITEM_PRESENT']);
  });

  it('is invalid with TREATMENT_ACTIVITY when a commit is targeted', () => {
    const assessment = gate([setOp(SUBJECT_FILES.provider, 'provider_transaction_committed', '/targeted', true)]);
    assert.equal(assessment.value, 'invalid');
    assert.deepEqual(codes(assessment.reasons), ['TREATMENT_ACTIVITY']);
  });

  it('is invalid with UNCONTROLLED_TIMEOUT after a caller timeout', () => {
    const timeout: TrialPlan = {
      deliveries: [{ attempts: [{ behavior: 'untargeted_timeout' }] }, { attempts: [{ behavior: 'succeeded' }] }],
      processing: 'completes',
    };
    const assessment = gate([], timeout);
    assert.equal(assessment.value, 'invalid');
    assert.ok(codes(assessment.reasons).every((code) => code === 'UNCONTROLLED_TIMEOUT'));
  });

  it('is unverified with SNAPSHOT_NOT_CONSISTENT when absence is not read consistently', () => {
    const assessment = gate([documentOp(SUBJECT_FILES.snapshot, '/consistent_read', false)]);
    assert.equal(assessment.value, 'unverified');
    assert.deepEqual(codes(assessment.reasons), ['SNAPSHOT_NOT_CONSISTENT']);
  });

  it('is unverified with CALLER_OUTCOME_NOT_CONCLUSIVE for an accepted call whose attempt failed', () => {
    const failed: TrialPlan = {
      deliveries: [{ attempts: [{ behavior: 'commit_failed' }] }, { attempts: [{ behavior: 'succeeded' }] }],
      processing: 'completes',
    };
    const assessment = gate([], failed);
    assert.equal(assessment.value, 'unverified');
    assert.deepEqual(codes(assessment.reasons), ['CALLER_OUTCOME_NOT_CONCLUSIVE']);
    assert.match(assessment.reasons[0]?.detail ?? '', /caller outcome FAILED/u);
  });

  it('is unverified for an accepted call without any outcome', () => {
    const assessment = gate([
      { op: 'remove_record', path: SUBJECT_FILES.caller, select: { record_type: 'attempt_outcome_recorded' } },
      { op: 'resequence', path: SUBJECT_FILES.caller },
    ]);
    assert.ok(codes(assessment.reasons).includes('CALLER_OUTCOME_NOT_CONCLUSIVE'));
    assert.match(
      assessment.reasons.find((reason) => reason.code === 'CALLER_OUTCOME_NOT_CONCLUSIVE')?.detail ?? '',
      /\(none\)/u,
    );
  });

  it('is unverified with ARTIFACT_MISSING without the configuration, snapshot or a journal', () => {
    assert.deepEqual(codes(gate([deleteOp(SUBJECT_FILES.configuration)]).reasons), ['ARTIFACT_MISSING']);
    assert.deepEqual(codes(gate([deleteOp(SUBJECT_FILES.snapshot)]).reasons), ['ARTIFACT_MISSING']);
    assert.deepEqual(codes(gate([deleteOp(SUBJECT_FILES.provider)]).reasons), ['ARTIFACT_MISSING']);
    const withoutCaller = gate([deleteOp(SUBJECT_FILES.caller)]);
    assert.equal(withoutCaller.value, 'unverified');
    assert.ok(codes(withoutCaller.reasons).includes('ARTIFACT_MISSING'));
  });

  it('is unverified with TRIAL_SCENARIO_UNKNOWN when the trial manifest is unusable', () => {
    const assessment = gate([documentOp('$trial/trial-manifest.json', '/scenario', 'UNKNOWN')]);
    assert.equal(assessment.value, 'unverified');
    assert.deepEqual(codes(assessment.reasons), ['TRIAL_SCENARIO_UNKNOWN']);
  });
});
