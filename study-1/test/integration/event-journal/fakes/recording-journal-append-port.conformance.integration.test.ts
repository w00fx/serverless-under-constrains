// Conformance of RecordingJournalAppendPort (design §12.2): as a decorator it must be
// transparent. Every outcome of the wrapped real port reaches the caller unchanged, the stored
// state is exactly what the wrapped port stored, and each entry is recorded in call order. Its
// one fault, `throwNext`, throws without reaching the wrapped port.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDurableJournalPort } from '../../../../src/event-journal/durable-journal-port.ts';
import { toJournalEntry } from '../../../../src/event-journal/journal-entry.ts';
import { buildJournalEvent } from '../../../../src/event-journal/journal-event.ts';
import { journalItemKey } from '../../../../src/event-journal/journal-scope.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { storeHarness } from '../../../support/durable-store/item-store-fixtures.ts';
import {
  dispatchStartedBody,
  EPOCH_UTC,
  INSTANCE_ID,
  TRIAL_SCOPE,
} from '../../../support/event-journal/journal-fixtures.ts';
import { RecordingJournalAppendPort } from '../../../support/event-journal/recording-journal-append-port.ts';

function entry(sequence: number): ReturnType<typeof toJournalEntry> {
  const event = buildJournalEvent('dispatch_started', dispatchStartedBody(sequence), {
    scope: TRIAL_SCOPE,
    source: 'durable_caller',
    source_instance_id: INSTANCE_ID,
    source_sequence: sequence,
    event_id: `ffffffff-0000-4000-8000-00000000000${String(sequence)}` as Uuid4,
    occurred_at: EPOCH_UTC,
    causation: [],
  });
  return toJournalEntry(journalItemKey(TRIAL_SCOPE, 'durable_caller', INSTANCE_ID, sequence), event);
}

describe('RecordingJournalAppendPort conformance', () => {
  it('forwards outcomes unchanged and records entries in call order', async () => {
    const { store } = storeHarness();
    const port = new RecordingJournalAppendPort(createDurableJournalPort(store, 'caller_journal'));
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'ThrottlingException' });
    const outcomes = [await port.append(entry(1)), await port.append(entry(1)), await port.append(entry(2))];
    assert.deepEqual(outcomes, [
      { kind: 'definitive_failure', code: 'ThrottlingException' },
      { kind: 'applied' },
      { kind: 'applied' },
    ]);
    assert.deepEqual(port.outcomes(), outcomes);
    assert.deepEqual(
      port.entries().map((recorded) => recorded.event.source_sequence),
      [1, 1, 2],
    );
    assert.deepEqual(
      store.itemsIn('caller_journal').map((item) => item['source_sequence']),
      [1, 2],
    );
  });

  it('throwNext throws once without reaching the wrapped port', async () => {
    const { store, log } = storeHarness();
    const port = new RecordingJournalAppendPort(createDurableJournalPort(store, 'caller_journal'));
    const failure = new Error('connection reset');
    port.throwNext(failure);
    await assert.rejects(port.append(entry(1)), failure);
    assert.equal(log.isEmpty(), true);
    assert.deepEqual(port.outcomes(), []);
    assert.equal(port.entries().length, 1);
    assert.deepEqual(await port.append(entry(1)), { kind: 'applied' });
  });
});
