// How K binds to K′, the ledger and the treatment item, and the first accepted call (BR-RUA-025,
// design §8.3 G4b).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { GateCause } from '../../../src/evidence-ingestion/gate-assessment.ts';
import { commitTripleCauses, firstAcceptedCallCauses } from '../../../src/treatment-fidelity/commit-binding.ts';
import { EXTRA_CALL_PLAN, PROBE_IDS, probeEvidence, treatmentView } from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { present, withRecord } from './support/view-edits.ts';

function causeCodes(causes: readonly GateCause[]): readonly (readonly [string, string])[] {
  return causes.map((cause) => [cause.value, cause.reason.code] as const);
}

describe('commitTripleCauses', () => {
  it('finds nothing when K′, the ledger and the treatment item agree with K', () => {
    assert.deepEqual(commitTripleCauses(treatmentView(probeEvidence())), []);
  });

  it('is invalid when K′ records another call', () => {
    const causes = commitTripleCauses(treatmentView(probeEvidence(PROBE_EDITS.confirmation_other_call)));
    assert.deepEqual(causeCodes(causes), [['invalid', 'COMMIT_TRIPLE_MISMATCH']]);
    assert.match(causes[0]?.reason.detail ?? '', /^provider_commit_confirmed records commit triple/u);
    assert.equal(causes[0]?.reason.event_id, PROBE_IDS.confirmation_event);
  });

  it('is invalid when the ledger transaction records another commit', () => {
    const causes = commitTripleCauses(treatmentView(probeEvidence(PROBE_EDITS.ledger_other_commit)));
    assert.deepEqual(causeCodes(causes), [['invalid', 'COMMIT_TRIPLE_MISMATCH']]);
    assert.equal(causes[0]?.reason.artifact_path, 'probe/ledger/ledger-snapshot.json');
  });

  it('is invalid when the treatment item records another call', () => {
    const causes = commitTripleCauses(treatmentView(probeEvidence(PROBE_EDITS.snapshot_other_call)));
    assert.deepEqual(causeCodes(causes), [['invalid', 'COMMIT_TRIPLE_MISMATCH']]);
    assert.equal(causes[0]?.reason.artifact_path, 'probe/state/treatment-state-snapshot.json');
  });

  it('is unverified with LEDGER_TRANSACTION_MISSING when a present ledger lacks K', () => {
    const causes = commitTripleCauses(treatmentView(probeEvidence(PROBE_EDITS.ledger_without_commit)));
    assert.deepEqual(causeCodes(causes), [['unverified', 'LEDGER_TRANSACTION_MISSING']]);
  });

  it('judges no ledger binding when the ledger is absent', () => {
    assert.deepEqual(commitTripleCauses(treatmentView(probeEvidence(PROBE_EDITS.no_ledger))), []);
  });

  it('ignores a source that omits a triple member, and a missing K′ or treatment item', () => {
    const view = treatmentView(probeEvidence());
    const partial = withRecord(present(view.confirmation, 'confirmation'), {
      provider_call_id: undefined as unknown as string,
    });
    assert.deepEqual(commitTripleCauses({ ...view, confirmation: partial }), []);
    const { confirmation: _k, snapshot: _s, ...bare } = view;
    assert.deepEqual(commitTripleCauses(bare), []);
  });

  it('judges nothing without K', () => {
    assert.deepEqual(commitTripleCauses(treatmentView(probeEvidence(PROBE_EDITS.two_targeted_commits))), []);
  });
});

describe('firstAcceptedCallCauses', () => {
  it('finds nothing when the first accepted call is K’s', () => {
    assert.deepEqual(firstAcceptedCallCauses(treatmentView(probeEvidence())), []);
  });

  it('finds nothing for a later accepted call after the targeted one', () => {
    assert.deepEqual(firstAcceptedCallCauses(treatmentView(probeEvidence([], EXTRA_CALL_PLAN))), []);
  });

  it('is invalid with FIRST_ACCEPTED_CALL_UNTARGETED when an earlier call is not K’s', () => {
    const view = treatmentView(probeEvidence());
    const accepted = present(view.accepted_calls[0], 'accepted call');
    const earlier = withRecord(accepted, {
      provider_call_id: PROBE_IDS.absent,
      occurred_at: '2026-10-05T12:05:05.000Z',
      event_id: '5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c',
    });
    const causes = firstAcceptedCallCauses({ ...view, accepted_calls: [accepted, earlier] });
    assert.deepEqual(causeCodes(causes), [['invalid', 'FIRST_ACCEPTED_CALL_UNTARGETED']]);
  });

  it('keeps journal order for calls accepted at the same instant', () => {
    const view = treatmentView(probeEvidence());
    const accepted = present(view.accepted_calls[0], 'accepted call');
    const simultaneous = withRecord(accepted, { provider_call_id: PROBE_IDS.absent });
    assert.deepEqual(firstAcceptedCallCauses({ ...view, accepted_calls: [accepted, simultaneous] }), []);
    assert.equal(firstAcceptedCallCauses({ ...view, accepted_calls: [simultaneous, accepted] }).length, 1);
  });

  it('is unverified with ACCEPTED_CALL_MISSING when no call was accepted', () => {
    const causes = firstAcceptedCallCauses(treatmentView(probeEvidence(PROBE_EDITS.no_provider_journal)));
    assert.deepEqual(causeCodes(causes), [['unverified', 'ACCEPTED_CALL_MISSING']]);
    assert.deepEqual(causes[0]?.refs, []);
    const view = treatmentView(probeEvidence());
    const located = firstAcceptedCallCauses({ ...view, accepted_calls: [] });
    assert.equal(located[0]?.reason.artifact_path, 'probe/journals/provider-journal.jsonl');
  });

  it('judges no targeting without K', () => {
    assert.deepEqual(firstAcceptedCallCauses(treatmentView(probeEvidence(PROBE_EDITS.two_targeted_commits))), []);
  });
});
