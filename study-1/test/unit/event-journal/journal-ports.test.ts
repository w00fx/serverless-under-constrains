// The two journal media: a journal table (one conditional put per event, so evidence is never
// overwritten) and a JSONL file (one canonical record per line, BR-RUA-033; file outcomes map
// onto applied, definitive and ambiguous).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import { toJournalEntry } from '../../../src/event-journal/journal-entry.ts';
import { buildJournalEvent } from '../../../src/event-journal/journal-event.ts';
import { journalItemKey } from '../../../src/event-journal/journal-scope.ts';
import { createJsonlJournalPort, toWriteOutcome } from '../../../src/event-journal/jsonl-journal-port.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';
import {
  dispatchStartedBody,
  EPOCH_UTC,
  INSTANCE_ID,
  JSONL_PATH,
  TRIAL_SCOPE,
} from '../../support/event-journal/journal-fixtures.ts';
import { MemoryAppendOnlyFile } from '../../support/event-journal/memory-append-only-file.ts';

function entry(sequence: number, refund = 1): ReturnType<typeof toJournalEntry> {
  const event = buildJournalEvent('dispatch_started', dispatchStartedBody(refund), {
    scope: TRIAL_SCOPE,
    source: 'conventional_caller',
    source_instance_id: INSTANCE_ID,
    source_sequence: sequence,
    event_id: `ffffffff-0000-4000-8000-00000000000${String(sequence)}` as Uuid4,
    occurred_at: EPOCH_UTC,
    causation: [],
  });
  return toJournalEntry(journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, sequence), event);
}

describe('createDurableJournalPort', () => {
  it('stores the item in its journal table and never overwrites it', async () => {
    const { store, log } = storeHarness();
    const port = createDurableJournalPort(store, 'experiment_journal');
    const first = entry(1);
    assert.deepEqual(await port.append(first), { kind: 'applied' });
    assert.deepEqual(store.peek('experiment_journal', first.key), first.item);
    assert.deepEqual(await port.append(entry(1, 2)), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: first.item,
    });
    assert.deepEqual(store.peek('experiment_journal', first.key), first.item);
    assert.deepEqual(
      log.entries().map(({ operation, target }) => [operation, target]),
      [
        ['PutItem', 'experiment_journal'],
        ['PutItem', 'experiment_journal'],
      ],
    );
  });

  it('passes store faults through unchanged', async () => {
    const { store } = storeHarness();
    store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: false });
    assert.deepEqual(await createDurableJournalPort(store, 'caller_journal').append(entry(1)), {
      kind: 'ambiguous',
      code: 'TimeoutError',
    });
  });
});

describe('createJsonlJournalPort', () => {
  it('appends one canonical JSON line per event', async () => {
    const file = new MemoryAppendOnlyFile();
    const port = createJsonlJournalPort(JSONL_PATH, file);
    assert.deepEqual(await port.append(entry(1)), { kind: 'applied' });
    assert.deepEqual(await port.append(entry(2)), { kind: 'applied' });
    const expected = [entry(1), entry(2)].map((e) => `${canonicalJson(e.event as unknown as JsonValue)}\n`).join('');
    assert.equal(file.text(JSONL_PATH), expected);
  });

  it('a finalized file is a definitive failure that writes nothing', async () => {
    const file = new MemoryAppendOnlyFile();
    await file.finalize(JSONL_PATH);
    assert.deepEqual(await createJsonlJournalPort(JSONL_PATH, file).append(entry(1)), {
      kind: 'definitive_failure',
      code: 'FILE_FINALIZED',
    });
    assert.equal(file.text(JSONL_PATH), '');
  });

  it('refuses an empty path', () => {
    assert.throws(() => createJsonlJournalPort('', new MemoryAppendOnlyFile()), {
      name: 'RangeError',
      message: 'JSONL journal path ""; expected a non-empty file path',
    });
  });

  it('maps file outcomes onto store outcomes', () => {
    assert.deepEqual(toWriteOutcome({ kind: 'appended' }), { kind: 'applied' });
    assert.deepEqual(toWriteOutcome({ kind: 'not_written', code: 'EACCES' }), {
      kind: 'definitive_failure',
      code: 'EACCES',
    });
    assert.deepEqual(toWriteOutcome({ kind: 'unknown', code: 'EIO' }), { kind: 'ambiguous', code: 'EIO' });
  });
});
