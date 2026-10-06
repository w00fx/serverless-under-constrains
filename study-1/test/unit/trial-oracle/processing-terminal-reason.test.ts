// The trial's processing terminal reason (design §8.7, D-17): the FINISHED request state, the DLQ
// capture of the trial message and the runner's interruption, with the agreement and last-receive
// checks that make it null instead.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deriveProcessingTerminalReason,
  MAX_RECEIVE_COUNT,
} from '../../../src/trial-oracle/processing-terminal-reason.ts';
import type { TerminalReasonDerivation } from '../../../src/trial-oracle/processing-terminal-reason.ts';
import { builtEvidence } from './support/built-trials.ts';
import { ACTIVE_CONTROL, CONVENTIONAL_CONTROL, DLQ_TREATMENT, edited } from './support/trial-plans.ts';
import { appendRunnerEvent, subjectRecord, textMember } from './support/trial-edits.ts';

const CALLER = '$trial/journals/caller-journal.jsonl';
const DLQ = '$trial/queues/dlq-snapshot.json';
const FINISHED_OF_DLQ = { record_type: 'request_state_recorded', occurrence: 2 } as const;
const REDELIVERY = { record_type: 'caller_invocation_started', occurrence: 2 } as const;

const derive = (build: Parameters<typeof builtEvidence>[0]): TerminalReasonDerivation =>
  deriveProcessingTerminalReason(builtEvidence(build));
const paths = (
  refs: readonly { readonly artifact_path: string; readonly json_pointer?: string }[],
): readonly string[] =>
  refs.map((ref) => `${ref.artifact_path.replace(/^trials\/[0-9a-f-]+\//, '$trial/')}${ref.json_pointer ?? ''}`);

describe('deriveProcessingTerminalReason', () => {
  it('reads the reason a FINISHED request state records', () => {
    const derivation = derive(CONVENTIONAL_CONTROL);
    assert.equal(derivation.reason, 'SUCCEEDED');
    assert.deepEqual(derivation.reasons, []);
    assert.deepEqual(paths(derivation.evidence_refs), [CALLER]);
    assert.equal(MAX_RECEIVE_COUNT, 2);
  });

  it('confirms RETRIES_EXHAUSTED with the DLQ capture of the trial message', () => {
    const derivation = derive(DLQ_TREATMENT);
    assert.equal(derivation.reason, 'RETRIES_EXHAUSTED');
    assert.deepEqual(paths(derivation.evidence_refs), [CALLER, `${DLQ}/messages/0`]);
  });

  it('is a conflict when the DLQ holds the message but the request state finished otherwise', () => {
    const derivation = derive(
      edited(DLQ_TREATMENT, [
        {
          op: 'set',
          path: CALLER,
          select: FINISHED_OF_DLQ,
          pointer: '/processing_terminal_reason',
          value: 'SUCCEEDED',
        },
      ]),
    );
    assert.equal(derivation.reason, null);
    assert.deepEqual(
      derivation.reasons.map((reason) => [reason.code, reason.subject]),
      [['PROCESSING_TERMINAL_CONFLICT', 'BR-RUA-030']],
    );
    assert.match(derivation.reasons[0]?.detail ?? '', /finished SUCCEEDED; expected RETRIES_EXHAUSTED/);
  });

  it('takes RETRIES_EXHAUSTED from the DLQ alone when no request state finished', () => {
    const derivation = derive(
      edited(DLQ_TREATMENT, [
        { op: 'remove_record', path: CALLER, select: FINISHED_OF_DLQ },
        { op: 'resequence', path: CALLER },
      ]),
    );
    assert.equal(derivation.reason, 'RETRIES_EXHAUSTED');
    assert.deepEqual(paths(derivation.evidence_refs), [`${DLQ}/messages/0`]);
  });

  it('matches the DLQ message by its body digest when its message id differs', () => {
    const derivation = derive(
      edited(DLQ_TREATMENT, [{ op: 'set', path: DLQ, pointer: '/messages/0/message_id', value: 'another-message' }]),
    );
    assert.equal(derivation.reason, 'RETRIES_EXHAUSTED');
    assert.deepEqual(paths(derivation.evidence_refs), [CALLER, `${DLQ}/messages/0`]);
  });

  it('ignores a DLQ message that is not the trial message', () => {
    const derivation = derive(
      edited(DLQ_TREATMENT, [
        { op: 'set', path: DLQ, pointer: '/messages/0/message_id', value: 'another-message' },
        { op: 'set', path: DLQ, pointer: '/messages/0/body_sha256', value: 'f'.repeat(64) },
      ]),
    );
    assert.equal(derivation.reason, 'RETRIES_EXHAUSTED');
    assert.equal(
      paths(derivation.evidence_refs).some((path) => path.startsWith(DLQ)),
      false,
    );
  });

  it('accepts RETRIES_EXHAUSTED without a DLQ capture from the invocation of the last receive', () => {
    const derivation = derive(edited(DLQ_TREATMENT, [{ op: 'delete_file', path: DLQ }]));
    assert.equal(derivation.reason, 'RETRIES_EXHAUSTED');
    assert.equal(derivation.evidence_refs.length, 2);
    assert.equal(
      derivation.evidence_refs[1]?.event_id,
      subjectRecord(DLQ_TREATMENT, CALLER, 'caller_invocation_started')['event_id'],
    );
  });

  it('rejects RETRIES_EXHAUSTED recorded before the last receive (BR-RUA-024)', () => {
    const derivation = derive(
      edited(DLQ_TREATMENT, [
        { op: 'delete_file', path: DLQ },
        { op: 'set', path: CALLER, select: REDELIVERY, pointer: '/approximate_receive_count', value: 1 },
      ]),
    );
    assert.equal(derivation.reason, null);
    assert.deepEqual(
      derivation.reasons.map((reason) => [reason.code, reason.subject]),
      [['TERMINALITY_BEFORE_LAST_LAYER', 'BR-RUA-024']],
    );
    assert.match(derivation.reasons[0]?.detail ?? '', /receive count 1; expected the last receive \(2\)/);
    assert.equal(derivation.evidence_refs.length, 2);
  });

  it('rejects RETRIES_EXHAUSTED whose deciding invocation is not recorded', () => {
    const derivation = derive(
      edited(DLQ_TREATMENT, [
        { op: 'delete_file', path: DLQ },
        { op: 'remove_record', path: CALLER, select: REDELIVERY },
        { op: 'resequence', path: CALLER },
      ]),
    );
    assert.equal(derivation.reason, null);
    assert.match(derivation.reasons[0]?.detail ?? '', /receive count \(unknown\)/);
    assert.deepEqual(paths(derivation.evidence_refs), [CALLER]);
  });

  it('is a conflict when FINISHED states disagree on the reason', () => {
    const finished = subjectRecord(CONVENTIONAL_CONTROL, CALLER, 'request_state_recorded');
    const derivation = derive(
      edited(CONVENTIONAL_CONTROL, [
        {
          op: 'clone_record',
          path: CALLER,
          select: { event_id: textMember(finished, 'event_id') },
          set: [
            { pointer: '/event_id', value: '5a7c9e1b-3d5f-4a2c-8e4b-6f8a0c2e4d61' },
            { pointer: '/version', value: Number(finished['version']) + 1 },
            { pointer: '/processing_terminal_reason', value: 'PROVIDER_REJECTED' },
          ],
        },
        { op: 'resequence', path: CALLER },
      ]),
    );
    assert.equal(derivation.reason, null);
    assert.equal(derivation.reasons[0]?.code, 'PROCESSING_TERMINAL_CONFLICT');
    assert.match(derivation.reasons[0].detail, /\(SUCCEEDED\) and .* \(PROVIDER_REJECTED\) disagree/);
    assert.equal(derivation.evidence_refs.length, 2);
  });

  it('maps a runner interruption when no request state finished and no DLQ capture exists', () => {
    const expected = {
      LEASE_LOST: 'INTERRUPTED',
      OPERATOR_ABORT: 'INTERRUPTED',
      INTERRUPTED: 'INTERRUPTED',
      SAFETY_DEADLINE: 'SAFETY_DEADLINE',
    };
    for (const [cause, reason] of Object.entries(expected)) {
      const derivation = derive(
        edited(ACTIVE_CONTROL, [
          appendRunnerEvent(ACTIVE_CONTROL, {
            record_type: 'trial_interrupted',
            cause,
            detail: 'the runner stopped the trial',
          }),
        ]),
      );
      assert.equal(derivation.reason, reason, cause);
      assert.deepEqual(paths(derivation.evidence_refs), ['runner/runner-journal.jsonl']);
    }
  });

  it('is null with PROCESSING_NOT_TERMINAL at the caller journal when processing is still active', () => {
    const derivation = derive(ACTIVE_CONTROL);
    assert.equal(derivation.reason, null);
    assert.deepEqual(
      derivation.reasons.map((reason) => [reason.code, reason.subject]),
      [['PROCESSING_NOT_TERMINAL', 'BR-RUA-030']],
    );
    assert.deepEqual(paths(derivation.evidence_refs), [CALLER]);
  });

  it('is null with ARTIFACT_MISSING when the caller journal is absent', () => {
    const derivation = derive(edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: CALLER }]));
    assert.equal(derivation.reason, null);
    assert.deepEqual(
      derivation.reasons.map((reason) => reason.code),
      ['ARTIFACT_MISSING'],
    );
    assert.deepEqual(derivation.evidence_refs, []);
  });
});
