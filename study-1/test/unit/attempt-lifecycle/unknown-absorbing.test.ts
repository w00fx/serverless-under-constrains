// AC-RUA-016: unknown knowledge is absorbing (BR-RUA-004, BR-RUA-022). Given any attempt
// establishes UNKNOWN, a later success, failure or rejection leaves the aggregate UNKNOWN.
// Attempts enter as (outcome, dispatch state) pairs, classified by the production
// classifier, so the cases cover the whole path from a recorded outcome to the aggregate.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { foldEffectKnowledge } from '../../../src/attempt-lifecycle/effect-knowledge.ts';
import { decideTerminality } from '../../../src/attempt-lifecycle/terminality.ts';
import type { OutcomeClass } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import { classifyOutcome } from '../../../src/attempt-lifecycle/outcome-classification.ts';
import type { AttemptOutcome, DispatchState } from '../../../src/record-contract/records/group-b/vocabulary.ts';

type RecordedAttempt = readonly [AttemptOutcome, DispatchState];

function aggregate(attempts: readonly RecordedAttempt[]): string {
  const classes = attempts.map(([outcome, dispatch]): OutcomeClass => {
    const classified = classifyOutcome(outcome, dispatch);
    assert.ok(classified.ok, `${outcome}/${dispatch} must classify`);
    return classified.value;
  });
  return foldEffectKnowledge(classes);
}

// BR-RUA-004: TIMED_OUT, FAILED + DISPATCHED and FAILED + UNKNOWN dispatch each establish UNKNOWN.
const ESTABLISHES_UNKNOWN: readonly RecordedAttempt[] = [
  ['TIMED_OUT', 'DISPATCHED'],
  ['FAILED', 'DISPATCHED'],
  ['FAILED', 'UNKNOWN'],
];

describe('AC-RUA-016 unknown knowledge is absorbing', () => {
  for (const first of ESTABLISHES_UNKNOWN) {
    it(`${first.join('/')} establishes UNKNOWN`, () => {
      assert.equal(aggregate([first]), 'UNKNOWN');
    });

    it(`unknown-then-success: ${first.join('/')} then SUCCEEDED stays UNKNOWN`, () => {
      assert.equal(aggregate([first, ['SUCCEEDED', 'DISPATCHED']]), 'UNKNOWN');
    });

    it(`unknown-then-failure: ${first.join('/')} then a failure stays UNKNOWN`, () => {
      assert.equal(aggregate([first, ['FAILED', 'NOT_DISPATCHED']]), 'UNKNOWN');
      assert.equal(aggregate([first, ['FAILED', 'DISPATCHED']]), 'UNKNOWN');
      assert.equal(aggregate([first, ['TIMED_OUT', 'DISPATCHED']]), 'UNKNOWN');
    });

    it(`unknown-then-rejection: ${first.join('/')} then REJECTED stays UNKNOWN`, () => {
      assert.equal(aggregate([first, ['REJECTED', 'DISPATCHED']]), 'UNKNOWN');
    });
  }

  it('UNKNOWN established after confirmed effects is still absorbing', () => {
    assert.equal(
      aggregate([
        ['SUCCEEDED', 'DISPATCHED'],
        ['FAILED', 'UNKNOWN'],
        ['SUCCEEDED', 'DISPATCHED'],
        ['REJECTED', 'DISPATCHED'],
      ]),
      'UNKNOWN',
    );
  });

  it('BR-RUA-022 example: a timeout followed by a successful retry keeps knowledge UNKNOWN', () => {
    // Processing may independently finish (FINISHED/SUCCEEDED); the knowledge aggregate does not
    // follow it, because the later success proves only the later effect (BR-RUA-004).
    assert.equal(
      aggregate([
        ['TIMED_OUT', 'DISPATCHED'],
        ['SUCCEEDED', 'DISPATCHED'],
      ]),
      'UNKNOWN',
    );
  });

  it('and processing may independently finish: FINISHED processing next to UNKNOWN knowledge', () => {
    // A conventional request: receive 1 times out (ambiguous), receive 2 fails after dispatch.
    // The first decision keeps processing RUNNING, the last receive FINISHES it, and the
    // knowledge aggregate stays UNKNOWN throughout: the two models move independently.
    const first: RecordedAttempt = ['TIMED_OUT', 'DISPATCHED'];
    const second: RecordedAttempt = ['FAILED', 'DISPATCHED'];
    assert.deepEqual(
      decideTerminality({
        variant: 'conventional',
        receive_count: 1,
        max_receive_count: 2,
        attempt_ambiguous_or_failed: true,
      }),
      { processing_state: 'RUNNING', upstream_can_redeliver: true },
    );
    assert.equal(aggregate([first]), 'UNKNOWN');
    assert.deepEqual(
      decideTerminality({
        variant: 'conventional',
        receive_count: 2,
        max_receive_count: 2,
        attempt_ambiguous_or_failed: true,
      }),
      { processing_state: 'FINISHED', terminal_reason: 'RETRIES_EXHAUSTED' },
    );
    assert.equal(aggregate([first, second]), 'UNKNOWN');
  });

  it('an outcome recorded with UNKNOWN dispatch evidence still feeds the aggregate (BR-RUA-004)', () => {
    assert.equal(aggregate([['TIMED_OUT', 'UNKNOWN']]), 'UNKNOWN');
    assert.equal(
      aggregate([
        ['TIMED_OUT', 'UNKNOWN'],
        ['SUCCEEDED', 'UNKNOWN'],
      ]),
      'UNKNOWN',
    );
  });

  it('without an ambiguous attempt the aggregate counts confirmed effects instead', () => {
    assert.equal(aggregate([]), 'NOT_ATTEMPTED');
    assert.equal(aggregate([['FAILED', 'NOT_DISPATCHED']]), 'NOT_ATTEMPTED');
    assert.equal(aggregate([['REJECTED', 'DISPATCHED']]), 'NO_EFFECT_CONFIRMED');
    assert.equal(aggregate([['SUCCEEDED', 'DISPATCHED']]), 'ONE_EFFECT_CONFIRMED');
    assert.equal(
      aggregate([
        ['SUCCEEDED', 'DISPATCHED'],
        ['SUCCEEDED', 'DISPATCHED'],
      ]),
      'MULTIPLE_EFFECTS_CONFIRMED',
    );
  });
});
