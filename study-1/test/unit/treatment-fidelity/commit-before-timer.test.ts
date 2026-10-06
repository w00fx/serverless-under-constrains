// BR-RUA-010 commit before timer (design §8.10, D-24): K′.committed_at < Θ.timer_fired_at under
// CA-1; reversed fails, equal or missing is indeterminate, and a complete journal and ledger
// without any commit of T fail.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evaluateCommitBeforeTimer } from '../../../src/treatment-fidelity/commit-before-timer.ts';
import { PROBE_IDS, probeEvidence, setOp, SUBJECT_FILES, treatmentView } from './support/treatment-evidence.ts';
import { PROBE_EDITS } from './support/treatment-scenarios.ts';
import { assertWellFormedCondition, codes, present, withRecord } from './support/view-edits.ts';

function judged(operations: Parameters<typeof probeEvidence>[0] = []): ReturnType<typeof evaluateCommitBeforeTimer> {
  const condition = evaluateCommitBeforeTimer(treatmentView(probeEvidence(operations)));
  assertWellFormedCondition(condition);
  return condition;
}

describe('BR-RUA-010 commit before timer', () => {
  it('passes when committed_at precedes timer_fired_at, reporting both signed differences', () => {
    const condition = judged();
    assert.equal(condition.result, 'pass');
    assert.deepEqual(condition.observed, {
      committed_at: '2026-10-05T12:05:05.130Z',
      commit_requested_at: '2026-10-05T12:05:05.120Z',
      timer_fired_at: '2026-10-05T12:05:08.040Z',
      timer_minus_committed_ms: '2910',
      timer_minus_commit_requested_ms: '2920',
      commit_event_id: PROBE_IDS.commit_event,
      confirmation_event_id: PROBE_IDS.confirmation_event,
      caller_timeout_event_id: PROBE_IDS.timeout_event,
      targeted_commit_count: 1,
    });
    // Canonical order: by artifact path (caller before provider), then by event id.
    assert.deepEqual(
      condition.evidence_refs.map((ref) => ref.event_id),
      [PROBE_IDS.timeout_event, PROBE_IDS.confirmation_event, PROBE_IDS.commit_event],
    );
  });

  it('states the empirical relation under CA-1, never a happened-before proof', () => {
    assert.deepEqual(judged().expected, {
      relation: 'provider_commit_confirmed.committed_at < caller_timeout_recorded.timer_fired_at',
      ordering_basis: 'cross_source_wall_clock',
      clock_assumption_refs: ['CA-1'],
    });
  });

  it('fails when committed_at follows timer_fired_at', () => {
    const condition = judged([
      setOp(SUBJECT_FILES.provider, 'provider_commit_confirmed', '/committed_at', '2026-10-05T12:05:08.050Z'),
    ]);
    assert.equal(condition.result, 'fail');
    assert.equal((condition.observed as { timer_minus_committed_ms: string }).timer_minus_committed_ms, '-10');
  });

  it('is indeterminate with EQUAL_TIMESTAMPS located at K′ when the instants are equal', () => {
    const condition = judged([
      setOp(SUBJECT_FILES.provider, 'provider_commit_confirmed', '/committed_at', '2026-10-05T12:05:08.040Z'),
    ]);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EQUAL_TIMESTAMPS']);
    assert.equal(condition.indeterminate_reasons[0]?.event_id, PROBE_IDS.confirmation_event);
  });

  it('is indeterminate with EVENT_MISSING when K′ is absent', () => {
    const condition = judged(PROBE_EDITS.no_confirmation);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['EVENT_MISSING']);
    assert.equal(condition.indeterminate_reasons[0]?.artifact_path, 'probe/journals/provider-journal.jsonl');
  });

  it('is indeterminate with TARGETED_COMMIT_AMBIGUOUS when two targeted commits exist', () => {
    const condition = judged(PROBE_EDITS.two_targeted_commits);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['TARGETED_COMMIT_AMBIGUOUS']);
    assert.equal((condition.observed as { targeted_commit_count: number }).targeted_commit_count, 2);
  });

  it('names the missing provider journal as ARTIFACT_MISSING', () => {
    const condition = judged(PROBE_EDITS.no_provider_journal);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(codes(condition.indeterminate_reasons), ['ARTIFACT_MISSING']);
  });

  it('is indeterminate with EVENT_MISSING when Θ is absent from the caller journal', () => {
    const condition = judged(PROBE_EDITS.no_caller_timeout);
    assert.equal(condition.result, 'indeterminate');
    assert.ok(codes(condition.indeterminate_reasons).includes('EVENT_MISSING'));
    assert.equal((condition.observed as { timer_fired_at: null }).timer_fired_at, null);
  });

  it('names the missing caller journal as ARTIFACT_MISSING', () => {
    const condition = judged(PROBE_EDITS.no_caller_journal);
    assert.deepEqual(codes(condition.indeterminate_reasons), ['ARTIFACT_MISSING']);
    assert.equal(condition.indeterminate_reasons[0]?.artifact_path, 'probe/journals/caller-journal.jsonl');
  });

  it('fails when a complete journal and ledger hold no commit of the targeted attempt', () => {
    const condition = judged(PROBE_EDITS.no_commit);
    assert.equal(condition.result, 'fail');
    assert.deepEqual(
      condition.evidence_refs.map((ref) => ref.artifact_path),
      [
        'probe/journals/caller-journal.jsonl',
        'probe/journals/provider-journal.jsonl',
        'probe/ledger/ledger-snapshot.json',
      ],
    );
  });

  it('stays indeterminate without a commit when the ledger is not usable', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.no_commit));
    const incomplete = evaluateCommitBeforeTimer({ ...view, ledger: { ...view.ledger, pagination_complete: false } });
    assert.equal(incomplete.result, 'indeterminate');
    const absent = evaluateCommitBeforeTimer({ ...view, ledger: { ...view.ledger, status: 'missing' } });
    assert.equal(absent.result, 'indeterminate');
    const duplicated = evaluateCommitBeforeTimer({
      ...view,
      ledger: { ...view.ledger, duplicate_transaction_ids: [PROBE_IDS.transaction] },
    });
    assert.equal(duplicated.result, 'indeterminate');
  });

  it('stays indeterminate without a commit when the ledger or journal still shows one of T', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.no_commit));
    const base = treatmentView(probeEvidence());
    assert.equal(evaluateCommitBeforeTimer({ ...view, ledger: base.ledger }).result, 'indeterminate');
    const untargeted = withRecord(present(base.commits[0], 'commit'), { targeted: false });
    assert.equal(evaluateCommitBeforeTimer({ ...view, commits: [untargeted] }).result, 'indeterminate');
    const incompleteProvider = { ...view.journals.provider, complete: false };
    assert.equal(
      evaluateCommitBeforeTimer({ ...view, journals: { ...view.journals, provider: incompleteProvider } }).result,
      'indeterminate',
    );
  });

  it('stays indeterminate without a commit when the targeted attempt is unknown', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.no_commit));
    const { targeted_attempt_id: _attempt, ...unknownAttempt } = view;
    const condition = evaluateCommitBeforeTimer(unknownAttempt);
    assert.equal(condition.result, 'indeterminate');
  });

  it('names an unknown targeted attempt when Θ is missing', () => {
    const view = treatmentView(probeEvidence(PROBE_EDITS.no_caller_timeout));
    const { targeted_attempt_id: _attempt, ...unknownAttempt } = view;
    const condition = evaluateCommitBeforeTimer(unknownAttempt);
    assert.match(condition.indeterminate_reasons[0]?.detail ?? '', /targeted attempt \(unknown\)/u);
  });

  it('never compares a timestamp that is not a UTC millisecond instant (A-05)', () => {
    const view = treatmentView(probeEvidence());
    const timeout = withRecord(present(view.caller_timeout, 'caller timeout'), { timer_fired_at: 'later' });
    const condition = evaluateCommitBeforeTimer({ ...view, caller_timeout: timeout });
    assert.equal(condition.result, 'indeterminate');
    assert.equal((condition.observed as { timer_minus_committed_ms: null }).timer_minus_committed_ms, null);
  });

  it('downgrades to indeterminate when the cited evidence carries an ingestion finding', () => {
    const condition = judged(PROBE_EDITS.invalid_outcome_record);
    assert.equal(condition.result, 'indeterminate');
    assert.deepEqual(condition.affected_by, ['RECORD_SCHEMA_INVALID']);
  });
});
