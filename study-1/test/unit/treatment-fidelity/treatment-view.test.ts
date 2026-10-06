// The treatment view (design §8.10): K, K′, T, Θ, Σ, Ω and Ρ bound once for the probe or a
// COMMIT_THEN_TIMEOUT trial; a CONTROL or unknown-scenario trial has none.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTreatmentView } from '../../../src/treatment-fidelity/treatment-view.ts';
import {
  documentOp,
  PROBE_IDS,
  probeEvidence,
  SUBJECT_FILES,
  treatmentView,
  trialEvidence,
} from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { present, withRecord } from './support/view-edits.ts';

describe('buildTreatmentView', () => {
  it('binds every treatment event of the base probe', () => {
    const view = treatmentView(probeEvidence());
    assert.equal(view.commit?.record.event_id, PROBE_IDS.commit_event);
    assert.equal(view.confirmation?.record.event_id, PROBE_IDS.confirmation_event);
    assert.equal(view.targeted_attempt_id, PROBE_IDS.attempt);
    assert.equal(view.dispatch?.record.event_id, PROBE_IDS.dispatch_event);
    assert.equal(view.caller_timeout?.record.event_id, PROBE_IDS.timeout_event);
    assert.equal(view.outcome?.record.event_id, PROBE_IDS.outcome_event);
    assert.equal(view.signal?.record.event_id, PROBE_IDS.signal_event);
    assert.equal(view.observation?.record.event_id, PROBE_IDS.observation_event);
    assert.equal(view.release?.record.event_id, PROBE_IDS.release_event);
    assert.equal(view.attempt_events.length, 5);
    assert.equal(view.late_settlements.length, 1);
    assert.deepEqual([view.safety_releases.length, view.conflicts.length], [0, 0]);
    assert.deepEqual([view.commits.length, view.accepted_calls.length, view.targeted_commits.length], [1, 1, 1]);
    assert.equal(view.configuration?.record.scenario, 'COMMIT_THEN_TIMEOUT');
    assert.equal(view.snapshot?.record.item_present, true);
    assert.equal(view.ledger.status, 'present');
    assert.deepEqual(
      [view.journals.caller.complete, view.journals.provider.complete, view.journals.controller.complete],
      [true, true, true],
    );
  });

  it('binds the view of a COMMIT_THEN_TIMEOUT trial', () => {
    for (const base of ['run-conventional-treatment', 'run-durable-treatment'] as const) {
      const view = treatmentView(trialEvidence(base));
      assert.equal(view.commit?.record.targeted, true, base);
      assert.notEqual(view.caller_timeout, undefined, base);
    }
  });

  it('refuses a CONTROL trial with TREATMENT_NOT_APPLICABLE', () => {
    const view = buildTreatmentView(trialEvidence('run-conventional-control'));
    assert.equal(view.ok, false);
    assert.deepEqual(
      view.error.map((reason) => [reason.code, reason.subject]),
      [['TREATMENT_NOT_APPLICABLE', 'BR-RUA-025']],
    );
    assert.match(view.error[0]?.detail ?? '', /scenario is CONTROL/u);
  });

  it('refuses a trial whose scenario is unknown', () => {
    const evidence = trialEvidence('run-conventional-treatment', [
      documentOp('$trial/trial-manifest.json', '/scenario', 'UNKNOWN'),
    ]);
    const view = buildTreatmentView(evidence);
    assert.equal(view.ok, false);
    assert.match(view.error[0]?.detail ?? '', /scenario is unknown/u);
  });

  it('finds K′ by its transaction when it lost its causation', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.confirmation_not_caused_by_commit));
    assert.equal(view.confirmation?.record.event_id, PROBE_IDS.confirmation_event);
  });

  it('leaves K unbound and binds Σ, Ω and Ρ by T when two targeted commits exist', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.two_targeted_commits));
    assert.equal(view.commit, undefined);
    assert.equal(view.confirmation, undefined);
    assert.equal(view.targeted_commits.length, 2);
    assert.equal(view.targeted_attempt_id, PROBE_IDS.attempt);
    assert.equal(view.signal?.record.event_id, PROBE_IDS.signal_event);
    assert.equal(view.observation?.record.event_id, PROBE_IDS.observation_event);
  });

  it("takes T from the treatment item's targeted attempt when K is absent", () => {
    const evidence = probeEvidence([
      ...PROBE_EDITS.two_targeted_commits,
      documentOp(SUBJECT_FILES.snapshot, '/treatment/targeted_attempt_id', PROBE_IDS.absent),
    ]);
    assert.equal(treatmentView(evidence).targeted_attempt_id, PROBE_IDS.absent);
  });

  it('takes T from the only registered attempt without K or a treatment item', () => {
    const evidence = probeEvidence([...PROBE_EDITS.two_targeted_commits, ...PROBE_EDITS.no_snapshot]);
    const view = treatmentView(evidence);
    assert.equal(view.snapshot, undefined);
    assert.equal(view.targeted_attempt_id, PROBE_IDS.attempt);
  });

  it('leaves T unknown when several attempts are registered and nothing names one', () => {
    const evidence = probeEvidence([...PROBE_EDITS.two_targeted_commits, ...PROBE_EDITS.no_snapshot]);
    const view = treatmentView(evidence);
    const registered = evidence.events.subject.filter((event) => event.record.record_type === 'attempt_registered');
    const second = withRecord(present(registered[0], 'attempt registration'), { attempt_id: PROBE_IDS.absent });
    const doubled = { ...evidence, events: { ...evidence.events, subject: [...evidence.events.subject, second] } };
    const unknown = treatmentView(doubled);
    assert.equal(view.targeted_attempt_id, PROBE_IDS.attempt);
    assert.equal(unknown.targeted_attempt_id, undefined);
    assert.deepEqual(unknown.attempt_events, []);
    assert.equal(unknown.signal, undefined);
  });

  it('marks absent artifacts incomplete and reads absent documents as unbound', () => {
    const view = treatmentView(probeEvidence([...PROBE_EDITS.no_configuration, ...PROBE_EDITS.no_snapshot]));
    assert.equal(view.configuration, undefined);
    assert.equal(view.configuration_state.complete, false);
    assert.equal(view.configuration_state.path, 'probe/state/provider-trial-configuration.json');
    assert.equal(view.snapshot_state.ref, undefined);
  });
});
