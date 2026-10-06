// Treatment fidelity, gate G4b (BR-RUA-025, design §8.3 and §8.10, D-05): invalid on an
// unaffected failed condition, a conflict, a scenario or commit-triple mismatch, or an untargeted
// first call; unverified on a safety release, an indeterminate condition or missing evidence.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConditionResult } from '../../../src/record-contract/records/group-c/shared-shapes.ts';
import { evaluateTreatmentConditions } from '../../../src/treatment-fidelity/treatment-conditions.ts';
import { deriveTreatmentFidelity } from '../../../src/treatment-fidelity/treatment-fidelity.ts';
import type { FidelityAssessment } from '../../../src/treatment-fidelity/treatment-fidelity.ts';
import type { TreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import { probeEvidence, SAFETY_RELEASE_PLAN, treatmentView, trialEvidence } from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { codes, present } from './support/view-edits.ts';

function fidelityOfView(view: TreatmentView, conditions?: readonly ConditionResult[]): FidelityAssessment {
  return deriveTreatmentFidelity(conditions ?? evaluateTreatmentConditions(view), view);
}

function fidelityOf(...edits: Parameters<typeof probeEvidence>): FidelityAssessment {
  return fidelityOfView(treatmentView(probeEvidence(...edits)));
}

describe('deriveTreatmentFidelity', () => {
  it('is verified when all six conditions pass, under CA-1', () => {
    const fidelity = fidelityOf();
    assert.equal(fidelity.treatment_fidelity, 'verified');
    assert.equal(fidelity.fidelity_basis, 'causal_plus_cross_source_clock_assumption');
    assert.deepEqual(fidelity.clock_assumption_refs, ['CA-1']);
    assert.deepEqual(fidelity.reasons, []);
    assert.ok(
      fidelity.evidence_refs.some((ref) => ref.artifact_path === 'probe/state/provider-trial-configuration.json'),
    );
    assert.ok(fidelity.evidence_refs.some((ref) => ref.artifact_path === 'probe/state/treatment-state-snapshot.json'));
  });

  it('is verified for a COMMIT_THEN_TIMEOUT trial', () => {
    for (const base of ['run-conventional-treatment', 'run-durable-treatment'] as const) {
      assert.equal(fidelityOfView(treatmentView(trialEvidence(base))).treatment_fidelity, 'verified', base);
    }
  });

  it('is invalid with CONDITION_FAILED when a condition fails on unaffected evidence', () => {
    const fidelity = fidelityOf(PROBE_EDITS.elapsed_short);
    assert.equal(fidelity.treatment_fidelity, 'invalid');
    assert.deepEqual(codes(fidelity.reasons), ['CONDITION_FAILED']);
    assert.equal(fidelity.reasons[0]?.subject, 'BR-RUA-011');
  });

  it('is unverified when a condition fails on affected evidence', () => {
    const view = treatmentView(probeEvidence());
    const [first, ...rest] = evaluateTreatmentConditions(view);
    const affected: ConditionResult = { ...first, result: 'fail', affected_by: ['SOURCE_SEQUENCE_GAP'] };
    const fidelity = fidelityOfView(view, [affected, ...rest]);
    assert.equal(fidelity.treatment_fidelity, 'unverified');
    assert.deepEqual(codes(fidelity.reasons), ['CONDITION_INDETERMINATE']);
    assert.match(fidelity.reasons[0]?.detail ?? '', /SOURCE_SEQUENCE_GAP/u);
  });

  it('is unverified with CONDITION_INDETERMINATE for an indeterminate condition', () => {
    const fidelity = fidelityOf(PROBE_EDITS.no_confirmation);
    assert.equal(fidelity.treatment_fidelity, 'unverified');
    assert.deepEqual(codes(fidelity.reasons), ['CONDITION_INDETERMINATE']);
    assert.match(fidelity.reasons[0]?.detail ?? '', /BR-RUA-010 is indeterminate \(EVENT_MISSING\)/u);
  });

  it('is invalid with TIMEOUT_SIGNAL_CONFLICT on a recorded conflict', () => {
    const fidelity = fidelityOf(PROBE_EDITS.signal_conflict);
    assert.equal(fidelity.treatment_fidelity, 'invalid');
    assert.ok(codes(fidelity.reasons).includes('TIMEOUT_SIGNAL_CONFLICT'));
  });

  it('is invalid with SCENARIO_MISMATCH when the configuration is not COMMIT_THEN_TIMEOUT', () => {
    const view = treatmentView(probeEvidence());
    const control = present(
      trialEvidence('run-conventional-control').observations.provider_configuration,
      'CONTROL configuration',
    );
    assert.equal(control.record.scenario, 'CONTROL');
    const fidelity = fidelityOfView({ ...view, configuration: control });
    assert.equal(fidelity.treatment_fidelity, 'invalid');
    assert.deepEqual(codes(fidelity.reasons), ['SCENARIO_MISMATCH']);
    const { ref: _ref, ...unlocated } = view.configuration_state;
    const withoutRef = fidelityOfView({ ...view, configuration: control, configuration_state: unlocated });
    assert.deepEqual(codes(withoutRef.reasons), ['SCENARIO_MISMATCH']);
  });

  it('is unverified with ARTIFACT_MISSING without the configuration or the snapshot', () => {
    assert.deepEqual(codes(fidelityOf(PROBE_EDITS.no_configuration).reasons), ['ARTIFACT_MISSING']);
    const fidelity = fidelityOf(PROBE_EDITS.no_snapshot);
    assert.equal(fidelity.treatment_fidelity, 'unverified');
    assert.deepEqual(codes(fidelity.reasons), ['ARTIFACT_MISSING']);
  });

  it('is unverified with ARTIFACT_INCOMPLETE when the configuration is unreadable', () => {
    const view = treatmentView(probeEvidence());
    const { configuration: _configuration, ...unread } = view;
    const fidelity = fidelityOfView({
      ...unread,
      configuration_state: { ...view.configuration_state, complete: false },
    });
    assert.deepEqual(codes(fidelity.reasons), ['ARTIFACT_INCOMPLETE']);
  });

  it('is unverified with SAFETY_RELEASED after a safety release', () => {
    const fidelity = fidelityOf([], SAFETY_RELEASE_PLAN);
    assert.equal(fidelity.treatment_fidelity, 'unverified');
    assert.ok(codes(fidelity.reasons).includes('SAFETY_RELEASED'));
  });

  it('cites only the events of a safety release the snapshot does not show', () => {
    const released = treatmentView(probeEvidence([], SAFETY_RELEASE_PLAN));
    const fidelity = fidelityOfView({
      ...released,
      snapshot: present(treatmentView(probeEvidence()).snapshot, 'snapshot'),
    });
    const reason = fidelity.reasons.find((item) => item.code === 'SAFETY_RELEASED');
    assert.match(reason?.detail ?? '', /1 treatment_safety_released event\(s\), treatment state not released/u);
    assert.notEqual(reason?.event_id, undefined);
  });

  it('is unverified with SAFETY_RELEASED when only the snapshot shows the release', () => {
    const view = treatmentView(probeEvidence());
    const snapshot = present(view.snapshot, 'snapshot');
    const record = snapshot.record;
    const released = record.item_present
      ? { ...record, treatment: { ...record.treatment, state: 'SAFETY_RELEASED' as const } }
      : record;
    const fidelity = fidelityOfView({ ...view, snapshot: { ...snapshot, record: released } });
    assert.deepEqual(codes(fidelity.reasons), ['SAFETY_RELEASED']);
    assert.equal(fidelity.reasons[0]?.artifact_path, 'probe/state/treatment-state-snapshot.json');
  });

  it('is unverified with TARGETED_COMMIT_NOT_UNIQUE when K is not unique', () => {
    const fidelity = fidelityOf(PROBE_EDITS.two_targeted_commits);
    assert.equal(fidelity.treatment_fidelity, 'unverified');
    assert.ok(codes(fidelity.reasons).includes('TARGETED_COMMIT_NOT_UNIQUE'));
  });

  it('cites no provider journal for a missing K when the journal is absent', () => {
    const fidelity = fidelityOf(PROBE_EDITS.no_provider_journal);
    const reason = fidelity.reasons.find((item) => item.code === 'TARGETED_COMMIT_NOT_UNIQUE');
    assert.equal(reason?.artifact_path, undefined);
  });

  it('is invalid with COMMIT_TRIPLE_MISMATCH from the commit binding', () => {
    assert.deepEqual(codes(fidelityOf(PROBE_EDITS.snapshot_other_call).reasons), ['COMMIT_TRIPLE_MISMATCH']);
    assert.equal(fidelityOf(PROBE_EDITS.snapshot_other_call).treatment_fidelity, 'invalid');
  });
});
