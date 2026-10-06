// Orphan attempts (design §5.3 `reconcileOrphans`; BR-RUA-021, BR-RUA-004): attempt-state items
// of the request that its state does not account for, classed by their outcome event when one
// exists and by their durable phase otherwise.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findOrphanAttempts } from '../../../src/conventional-variant/request-state/orphan-attempts.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { TRIAL_PK } from '../trial-message/support/trial-message-fixtures.ts';

const ATTEMPT_A = 'dddddddd-0000-4000-8000-00000000000a' as Uuid4;
const ATTEMPT_B = 'dddddddd-0000-4000-8000-00000000000b' as Uuid4;
const REFUND = 'ref-poc-001';

function attemptItem(attemptId: Uuid4, phase: string, overrides: Readonly<Record<string, JsonValue>> = {}): StoredItem {
  return {
    pk: TRIAL_PK,
    sk: `state#attempt#${attemptId}`,
    attempt_id: attemptId,
    provider_request_id: 'eeeeeeee-0000-4000-8000-000000000001',
    refund_request_id: REFUND,
    phase,
    ...overrides,
  };
}

function outcomeItem(attemptId: JsonValue, outcome: JsonValue, dispatch: JsonValue): StoredItem {
  return {
    pk: TRIAL_PK,
    sk: `conventional_caller#cccccccc-0000-4000-8000-000000000001#000000000004`,
    record_type: 'attempt_outcome_recorded',
    attempt_id: attemptId,
    outcome,
    dispatch_state: dispatch,
  };
}

function orphans(items: readonly StoredItem[], accounted: readonly string[] = []): unknown {
  const found = findOrphanAttempts(items, REFUND, new Set(accounted));
  assert.equal(found.ok, true, found.ok ? '' : found.error);
  return found.value;
}

describe('findOrphanAttempts', () => {
  it('finds none in a partition without attempt-state items', () => {
    assert.deepEqual(orphans([]), []);
    assert.deepEqual(orphans([outcomeItem(ATTEMPT_A, 'SUCCEEDED', 'DISPATCHED')]), []);
  });

  it('classes an orphan without an outcome event by its phase', () => {
    assert.deepEqual(orphans([attemptItem(ATTEMPT_A, 'DISPATCHED')]), [
      { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
    ]);
    assert.deepEqual(orphans([attemptItem(ATTEMPT_A, 'PRE_DISPATCH')]), [
      { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
    ]);
    assert.deepEqual(orphans([attemptItem(ATTEMPT_A, 'NOT_DISPATCHED')]), [
      { attempt_id: ATTEMPT_A, outcome_class: 'PRE_DISPATCH_FAILURE' },
    ]);
  });

  it('classes an orphan by its recorded outcome event', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['SUCCEEDED', 'DISPATCHED', 'SUCCESS'],
      ['REJECTED', 'DISPATCHED', 'REJECTION'],
      ['TIMED_OUT', 'DISPATCHED', 'AMBIGUOUS'],
      ['FAILED', 'NOT_DISPATCHED', 'PRE_DISPATCH_FAILURE'],
      ['FAILED', 'UNKNOWN', 'AMBIGUOUS'],
    ];
    for (const [outcome, dispatch, cls] of cases) {
      assert.deepEqual(orphans([attemptItem(ATTEMPT_A, 'DISPATCHED'), outcomeItem(ATTEMPT_A, outcome, dispatch)]), [
        { attempt_id: ATTEMPT_A, outcome_class: cls },
      ]);
    }
  });

  it('falls back to the phase for an outcome event it cannot classify', () => {
    for (const outcome of [
      outcomeItem(ATTEMPT_A, 'SUCCEEDED', 'NOT_DISPATCHED'),
      outcomeItem(ATTEMPT_A, 'MAYBE', 'DISPATCHED'),
      outcomeItem(ATTEMPT_A, 'SUCCEEDED', 'SOMEWHERE'),
      outcomeItem(7, 'SUCCEEDED', 'DISPATCHED'),
      outcomeItem(ATTEMPT_B, 'SUCCEEDED', 'DISPATCHED'),
    ]) {
      assert.deepEqual(orphans([attemptItem(ATTEMPT_A, 'NOT_DISPATCHED'), outcome]), [
        { attempt_id: ATTEMPT_A, outcome_class: 'PRE_DISPATCH_FAILURE' },
      ]);
    }
  });

  it('skips attempts already accounted for and attempts of another request, keeping partition order', () => {
    const items = [
      attemptItem(ATTEMPT_A, 'DISPATCHED'),
      attemptItem(ATTEMPT_B, 'DISPATCHED'),
      attemptItem('dddddddd-0000-4000-8000-00000000000c' as Uuid4, 'DISPATCHED', { refund_request_id: 'ref-poc-002' }),
    ];
    assert.deepEqual(orphans(items), [
      { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
      { attempt_id: ATTEMPT_B, outcome_class: 'AMBIGUOUS' },
    ]);
    assert.deepEqual(orphans(items, [ATTEMPT_A]), [{ attempt_id: ATTEMPT_B, outcome_class: 'AMBIGUOUS' }]);
  });

  it('refuses a damaged attempt-state item, because it could hide an attempt', () => {
    for (const damaged of [
      attemptItem(ATTEMPT_A, 'SENT'),
      attemptItem(ATTEMPT_A, 'DISPATCHED', { attempt_id: 'x' }),
      attemptItem(ATTEMPT_A, 'DISPATCHED', { refund_request_id: 1 }),
    ]) {
      const found = findOrphanAttempts([damaged], REFUND, new Set());
      assert.equal(found.ok, false);
      assert.match(
        found.error,
        /^attempt-state item state#attempt#.*; expected a UUIDv4, a string and one of PRE_DISPATCH, NOT_DISPATCHED, DISPATCHED$/,
      );
    }
  });
});
