// The trial's attempts (BR-RUA-020, BR-RUA-021): registrations in time order, their dispatch state
// from durable evidence and their outcome class, with contradictions kept.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readAttempts } from '../../../src/trial-oracle/attempt-facts.ts';
import { builtEvidence } from './support/built-trials.ts';
import { builtRecords, CALLER_JOURNAL, notDispatched, withoutOutcome } from './support/trial-edits.ts';
import {
  ACTIVE_CONTROL,
  CONVENTIONAL_CONTROL,
  CONVENTIONAL_TREATMENT,
  DURABLE_TREATMENT,
  edited,
} from './support/trial-plans.ts';

describe('readAttempts', () => {
  it('reads a dispatched successful attempt with its invocation and outcome', () => {
    const [attempt, ...rest] = readAttempts(builtEvidence(CONVENTIONAL_CONTROL));
    assert.deepEqual(rest, []);
    assert.ok(attempt !== undefined);
    assert.equal(attempt.dispatch_state, 'DISPATCHED');
    assert.equal(attempt.outcome_class, 'SUCCESS');
    assert.equal(attempt.outcome?.record.outcome, 'SUCCEEDED');
    assert.equal(attempt.invocation?.record.source_instance_id, attempt.registered.record.source_instance_id);
    assert.equal(attempt.contradiction, undefined);
  });

  it('classifies a timeout ambiguous and the retry a success, in time order, per variant', () => {
    for (const build of [CONVENTIONAL_TREATMENT, DURABLE_TREATMENT]) {
      const attempts = readAttempts(builtEvidence(build));
      assert.deepEqual(
        attempts.map((attempt) => attempt.outcome_class),
        ['AMBIGUOUS', 'SUCCESS'],
        build.base,
      );
    }
  });

  it('orders registrations by occurred_at and keeps journal order on ties', () => {
    const [first] = builtRecords(CONVENTIONAL_TREATMENT, CALLER_JOURNAL).filter(
      (record) => record['record_type'] === 'attempt_registered',
    );
    assert.ok(first !== undefined);
    const select = { record_type: 'attempt_registered', occurrence: 2 } as const;
    const earlier = readAttempts(
      builtEvidence(
        edited(CONVENTIONAL_TREATMENT, [
          { op: 'set', path: CALLER_JOURNAL, select, pointer: '/occurred_at', value: '2026-10-05T12:00:00.000Z' },
        ]),
      ),
    );
    assert.deepEqual(
      earlier.map((attempt) => attempt.outcome_class),
      ['SUCCESS', 'AMBIGUOUS'],
    );
    const tied = readAttempts(
      builtEvidence(
        edited(CONVENTIONAL_TREATMENT, [
          { op: 'set', path: CALLER_JOURNAL, select, pointer: '/occurred_at', value: first['occurred_at'] ?? null },
        ]),
      ),
    );
    assert.deepEqual(
      tied.map((attempt) => attempt.outcome_class),
      ['AMBIGUOUS', 'SUCCESS'],
    );
    assert.equal(tied[1]?.registered.record.occurred_at, first['occurred_at']);
  });

  it('takes the dispatch an outcome implies when the dispatch record is missing (BR-RUA-021)', () => {
    const edits = [
      { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'dispatch_started' } },
      { op: 'resequence', path: CALLER_JOURNAL },
    ] as const;
    const [success] = readAttempts(builtEvidence(edited(CONVENTIONAL_CONTROL, edits)));
    assert.equal(success?.dispatch_state, 'DISPATCHED');
    assert.equal(success.outcome_class, 'SUCCESS');
    const failed = readAttempts(builtEvidence(edited(ACTIVE_CONTROL, edits)));
    assert.equal(failed[0]?.dispatch_state, 'UNKNOWN', 'FAILED implies nothing about dispatch');
    assert.equal(failed[0].outcome_class, 'AMBIGUOUS');
  });

  it('counts a dispatched attempt without an outcome as ambiguous (BR-RUA-021)', () => {
    const [attempt] = readAttempts(builtEvidence(edited(CONVENTIONAL_CONTROL, withoutOutcome(1))));
    assert.equal(attempt?.outcome, undefined);
    assert.equal(attempt?.dispatch_state, 'DISPATCHED');
    assert.equal(attempt.outcome_class, 'AMBIGUOUS');
  });

  it('counts an attempt proven not dispatched and without an outcome as a pre-dispatch failure', () => {
    const [attempt] = readAttempts(
      builtEvidence(edited(CONVENTIONAL_CONTROL, [...notDispatched(1), ...withoutOutcome(1)])),
    );
    assert.equal(attempt?.dispatch_state, 'NOT_DISPATCHED');
    assert.equal(attempt.outcome_class, 'PRE_DISPATCH_FAILURE');
  });

  it('counts an outcome that contradicts its dispatch evidence as ambiguous and keeps the contradiction', () => {
    const [attempt] = readAttempts(builtEvidence(edited(CONVENTIONAL_CONTROL, notDispatched(1))));
    assert.equal(attempt?.dispatch_state, 'NOT_DISPATCHED');
    assert.equal(attempt.outcome_class, 'AMBIGUOUS');
    assert.equal(attempt.contradiction?.subject, 'BR-RUA-021');
  });

  it('reads an attempt whose invocation start was not recorded without an invocation', () => {
    const [attempt] = readAttempts(
      builtEvidence(
        edited(CONVENTIONAL_CONTROL, [
          { op: 'remove_record', path: CALLER_JOURNAL, select: { record_type: 'caller_invocation_started' } },
          { op: 'resequence', path: CALLER_JOURNAL },
        ]),
      ),
    );
    assert.equal(attempt?.invocation, undefined);
    assert.equal(attempt?.outcome_class, 'SUCCESS');
  });

  it('reads no attempt from an absent caller journal', () => {
    assert.deepEqual(
      readAttempts(builtEvidence(edited(CONVENTIONAL_CONTROL, [{ op: 'delete_file', path: CALLER_JOURNAL }]))),
      [],
    );
  });
});
