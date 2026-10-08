// Journal entries and the BR-RUA-033 reading of a store outcome for one entry: an identical
// item already at the entry's key is the entry itself; different content there is a sequence
// conflict; a failure anywhere else left the entry unwritten.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import { classifyJournalOutcome } from '../../../src/event-journal/journal-append-port.ts';
import { isSameStoredEntry, journalPutAction, toJournalEntry } from '../../../src/event-journal/journal-entry.ts';
import { buildJournalEvent } from '../../../src/event-journal/journal-event.ts';
import { journalItemKey } from '../../../src/event-journal/journal-scope.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  dispatchStartedBody,
  EPOCH_UTC,
  INSTANCE_ID,
  TRIAL_SCOPE,
} from '../../support/event-journal/journal-fixtures.ts';

const KEY = journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, 1);
const EVENT = buildJournalEvent('dispatch_started', dispatchStartedBody(), {
  scope: TRIAL_SCOPE,
  source: 'conventional_caller',
  source_instance_id: INSTANCE_ID,
  source_sequence: 1,
  event_id: 'ffffffff-0000-4000-8000-000000000001' as Uuid4,
  occurred_at: EPOCH_UTC,
  causation: [],
});
const ENTRY = toJournalEntry(KEY, EVENT);

describe('journal entries', () => {
  it('the stored item is the event plus its key', () => {
    assert.deepEqual(ENTRY.item, { ...EVENT, pk: KEY.pk, sk: KEY.sk });
    assert.equal(ENTRY.key, KEY);
    assert.equal(ENTRY.event, EVENT);
  });

  it('the put action is conditional on an absent item', () => {
    assert.deepEqual(journalPutAction('experiment_journal', ENTRY), {
      kind: 'put',
      table: 'experiment_journal',
      item: ENTRY.item,
      condition: { kind: 'item_absent' },
    });
  });

  it('compares stored items by key and by structural content', () => {
    assert.equal(isSameStoredEntry({ ...ENTRY.item }, ENTRY), true);
    assert.equal(isSameStoredEntry({ ...ENTRY.item, pk: 'other' }, ENTRY), false);
    assert.equal(isSameStoredEntry({ ...ENTRY.item, sk: 'other' }, ENTRY), false);
    const reordered = Object.fromEntries(Object.entries(ENTRY.item).reverse()) as typeof ENTRY.item;
    assert.equal(isSameStoredEntry(reordered, ENTRY), true);
    assert.equal(isSameStoredEntry({ ...ENTRY.item, refund_request_id: 'ref-poc-002' }, ENTRY), false);
  });
});

describe('classifyJournalOutcome', () => {
  // The put in the middle of a three-action transaction (index 1): each outcome kind, and a
  // failed condition before it, on it and after it.
  const middleOfThree: readonly (readonly [string, WriteOutcome, string])[] = [
    ['applied', { kind: 'applied' }, 'applied'],
    ['ambiguous', { kind: 'ambiguous', code: 'TimeoutError' }, 'ambiguous'],
    ['definitive failure', { kind: 'definitive_failure', code: 'ValidationException' }, 'not_applied'],
    [
      'condition failed before the put, without an item',
      { kind: 'condition_failed', failed_action_index: 0 },
      'not_applied',
    ],
    [
      'condition failed after the put, on another item',
      { kind: 'condition_failed', failed_action_index: 2, existing: { pk: KEY.pk, sk: 'state#attempt#x' } },
      'not_applied',
    ],
    [
      'condition failed on the put, on the identical entry',
      { kind: 'condition_failed', failed_action_index: 1, existing: { ...ENTRY.item } },
      'applied',
    ],
    [
      'condition failed on the put, on other content at the entry key',
      { kind: 'condition_failed', failed_action_index: 1, existing: { ...ENTRY.item, event_id: 'x' } },
      'sequence_conflict',
    ],
  ];
  for (const [name, outcome, expected] of middleOfThree) {
    it(`with the put in the middle of three actions, ${name} is ${expected}`, () => {
      assert.equal(classifyJournalOutcome(outcome, ENTRY, 1), expected);
    });
  }

  // The put's index is required (WP-05 review round 2): the failed action decides whose
  // condition failed. A failed item_absent condition on the put proves the key occupied, so
  // without a decodable existing item (WP-04 omits an undecodable ALL_OLD image) it is a
  // sequence conflict, never not_applied. A failed condition elsewhere is not applied even when
  // the store returned an item, including one at the entry's own key.
  const withIndex: readonly (readonly [string, WriteOutcome, number, string])[] = [
    [
      'the put failed without a decodable item',
      { kind: 'condition_failed', failed_action_index: 0 },
      0,
      'sequence_conflict',
    ],
    [
      'the put failed (index 2) without a decodable item',
      { kind: 'condition_failed', failed_action_index: 2 },
      2,
      'sequence_conflict',
    ],
    [
      'the put failed on the identical entry',
      { kind: 'condition_failed', failed_action_index: 1, existing: { ...ENTRY.item } },
      1,
      'applied',
    ],
    [
      'the put failed on other content',
      { kind: 'condition_failed', failed_action_index: 1, existing: { ...ENTRY.item, event_id: 'x' } },
      1,
      'sequence_conflict',
    ],
    ['another action failed without an item', { kind: 'condition_failed', failed_action_index: 1 }, 0, 'not_applied'],
    [
      'another action failed with the identical entry returned',
      { kind: 'condition_failed', failed_action_index: 0, existing: { ...ENTRY.item } },
      1,
      'not_applied',
    ],
    [
      'another action failed on its own item',
      { kind: 'condition_failed', failed_action_index: 0, existing: { pk: KEY.pk, sk: 'state#attempt#x' } },
      1,
      'not_applied',
    ],
    ['a definitive failure', { kind: 'definitive_failure', code: 'ValidationException' }, 0, 'not_applied'],
    ['an ambiguous outcome', { kind: 'ambiguous', code: 'TimeoutError' }, 0, 'ambiguous'],
    ['an applied outcome', { kind: 'applied' }, 0, 'applied'],
  ];
  for (const [name, outcome, index, expected] of withIndex) {
    it(`with the put at index ${String(index)}, ${name} is ${expected}`, () => {
      assert.equal(classifyJournalOutcome(outcome, ENTRY, index), expected);
    });
  }
});
