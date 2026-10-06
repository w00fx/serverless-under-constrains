// Probe cardinality and validity (BR-RUA-027, design §8.11): exactly one invocation, accepted call
// and committed transaction; any count above 1 is invalid, an unestablished count indeterminate.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assessProbeValidity } from '../../../../src/transport-qualification/verdict/probe-validity.ts';
import { EXTRA_CALL_PLAN, probeEvidence, SUBJECT_FILES } from '../../treatment-fidelity/support/treatment-evidence.ts';
import { PROBE_EDITS } from '../../treatment-fidelity/support/treatment-scenarios.ts';
import { codes } from '../../treatment-fidelity/support/view-edits.ts';

/** The runner invoked the probe workload a second time, under another Lambda request id. */
const SECOND_INVOCATION = [
  {
    op: 'clone_record',
    path: SUBJECT_FILES.runner,
    select: { record_type: 'probe_workload_invoked' },
    set: [
      { pointer: '/event_id', value: '4d3c2b1a-0f9e-4d8c-8b7a-6f5e4d3c2b1a' },
      { pointer: '/lambda_request_id', value: '1c2b3a49-5867-4f8e-9d0c-a1b2c3d4e5f6' },
    ],
  },
  { op: 'resequence', path: SUBJECT_FILES.runner },
] as const;

describe('assessProbeValidity', () => {
  it('is valid with cardinality 1/1/1 for the base probe, citing the four counted artifacts', () => {
    const validity = assessProbeValidity(probeEvidence());
    assert.equal(validity.probe_validity, 'valid');
    assert.deepEqual(validity.cardinality, {
      caller_invocations: 1,
      accepted_provider_calls: 1,
      committed_transactions: 1,
    });
    assert.deepEqual(validity.reasons, []);
    assert.deepEqual(
      validity.evidence_refs.map((ref) => ref.artifact_path),
      [
        'probe/journals/caller-journal.jsonl',
        'probe/journals/provider-journal.jsonl',
        'probe/ledger/ledger-snapshot.json',
        'runner/runner-journal.jsonl',
      ],
    );
  });

  it('is invalid with PROBE_CARDINALITY_EXCEEDED for an extra accepted call and transaction', () => {
    const validity = assessProbeValidity(probeEvidence([], EXTRA_CALL_PLAN));
    assert.equal(validity.probe_validity, 'invalid');
    assert.deepEqual(validity.cardinality, {
      caller_invocations: 1,
      accepted_provider_calls: 2,
      committed_transactions: 2,
    });
    assert.deepEqual(codes(validity.reasons), ['PROBE_CARDINALITY_EXCEEDED', 'PROBE_CARDINALITY_EXCEEDED']);
    assert.match(validity.reasons[0]?.detail ?? '', /accepted_provider_calls is 2; expected exactly 1/u);
  });

  it('is invalid for a ledger holding two transactions', () => {
    const validity = assessProbeValidity(probeEvidence(PROBE_EDITS.ledger_duplicate));
    assert.equal(validity.probe_validity, 'invalid');
    assert.equal(validity.cardinality.committed_transactions, 2);
  });

  it('counts an invocation the runner made that never wrote its start', () => {
    const validity = assessProbeValidity(probeEvidence(SECOND_INVOCATION));
    assert.equal(validity.probe_validity, 'invalid');
    assert.equal(validity.cardinality.caller_invocations, 2);
  });

  it('is indeterminate with INVOCATION_CROSS_CHECK_FAILED without the runner journal', () => {
    const validity = assessProbeValidity(probeEvidence(PROBE_EDITS.no_runner_journal));
    assert.equal(validity.probe_validity, 'indeterminate');
    assert.deepEqual(codes(validity.reasons), ['ARTIFACT_MISSING', 'INVOCATION_CROSS_CHECK_FAILED']);
    assert.equal(validity.cardinality.caller_invocations, 1);
    assert.equal(validity.reasons[1]?.artifact_path, 'probe/journals/caller-journal.jsonl');
  });

  it('keeps the runner count and an unlocated cross-check reason without the caller journal', () => {
    const validity = assessProbeValidity(probeEvidence(PROBE_EDITS.no_caller_journal));
    assert.equal(validity.probe_validity, 'indeterminate');
    assert.equal(validity.cardinality.caller_invocations, 1);
    const crossCheck = validity.reasons.find((reason) => reason.code === 'INVOCATION_CROSS_CHECK_FAILED');
    assert.equal(crossCheck?.artifact_path, undefined);
  });

  it('is indeterminate when the provider journal is absent', () => {
    const validity = assessProbeValidity(probeEvidence(PROBE_EDITS.no_provider_journal));
    assert.equal(validity.probe_validity, 'indeterminate');
    assert.equal(validity.cardinality.accepted_provider_calls, 0);
    assert.deepEqual(codes(validity.reasons), ['ARTIFACT_MISSING']);
  });

  it('is indeterminate with ARTIFACT_MISSING without the ledger', () => {
    const validity = assessProbeValidity(probeEvidence(PROBE_EDITS.no_ledger));
    assert.equal(validity.probe_validity, 'indeterminate');
    assert.equal(validity.cardinality.committed_transactions, 0);
    assert.deepEqual(codes(validity.reasons), ['ARTIFACT_MISSING']);
  });

  it('is indeterminate with LEDGER_NOT_USABLE for an incomplete ledger', () => {
    const validity = assessProbeValidity(probeEvidence(PROBE_EDITS.ledger_incomplete));
    assert.equal(validity.probe_validity, 'indeterminate');
    assert.deepEqual(codes(validity.reasons), ['LEDGER_NOT_USABLE']);
    assert.match(validity.reasons[0]?.detail ?? '', /pagination incomplete/u);
  });

  it('names a present but unusable ledger by its status', () => {
    const evidence = probeEvidence();
    const unusable = { ...evidence, ledger: { ...evidence.ledger, status: 'unusable' as const } };
    const validity = assessProbeValidity(unusable);
    assert.deepEqual(codes(validity.reasons), ['LEDGER_NOT_USABLE']);
    assert.match(validity.reasons[0]?.detail ?? '', /the ledger is unusable with pagination complete/u);
  });
});
