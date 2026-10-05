// Journal entries and the BR-RUA-033 reading of a store outcome for one entry: an identical
// item already at the entry's key is the entry itself; different content there is a sequence
// conflict; a failure anywhere else left the entry unwritten.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import { classifyJournalOutcome } from '../../../src/event-journal/journal-append-port.ts';
import {
  holdsEntryKey,
  isSameStoredEntry,
  journalPutAction,
  toJournalEntry,
} from '../../../src/event-journal/journal-entry.ts';
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
    assert.equal(holdsEntryKey({ ...ENTRY.item }, ENTRY), true);
    assert.equal(holdsEntryKey({ ...ENTRY.item, pk: 'other' }, ENTRY), false);
    assert.equal(holdsEntryKey({ ...ENTRY.item, sk: 'other' }, ENTRY), false);
    const reordered = Object.fromEntries(Object.entries(ENTRY.item).reverse()) as typeof ENTRY.item;
    assert.equal(isSameStoredEntry(reordered, ENTRY), true);
    assert.equal(isSameStoredEntry({ ...ENTRY.item, refund_request_id: 'ref-poc-002' }, ENTRY), false);
  });
});

describe('classifyJournalOutcome', () => {
  const cases: readonly (readonly [string, WriteOutcome, string])[] = [
    ['applied', { kind: 'applied' }, 'applied'],
    ['ambiguous', { kind: 'ambiguous', code: 'TimeoutError' }, 'ambiguous'],
    ['definitive failure', { kind: 'definitive_failure', code: 'ValidationException' }, 'not_applied'],
    ['condition failed on an absent item', { kind: 'condition_failed', failed_action_index: 1 }, 'not_applied'],
    [
      'condition failed on another item',
      { kind: 'condition_failed', failed_action_index: 1, existing: { pk: KEY.pk, sk: 'state#attempt#x' } },
      'not_applied',
    ],
    [
      'condition failed on the identical entry',
      { kind: 'condition_failed', failed_action_index: 0, existing: { ...ENTRY.item } },
      'applied',
    ],
    [
      'condition failed on other content at the entry key',
      { kind: 'condition_failed', failed_action_index: 0, existing: { ...ENTRY.item, event_id: 'x' } },
      'sequence_conflict',
    ],
  ];
  for (const [name, outcome, expected] of cases) {
    it(`${name} is ${expected}`, () => {
      assert.equal(classifyJournalOutcome(outcome, ENTRY), expected);
    });
  }
});
