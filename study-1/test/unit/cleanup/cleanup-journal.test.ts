// The cleanup journal (design §7 `cleanup/cleanup-journal.jsonl`): every action is appended by
// the real JournalWriter and kept in memory; once the journal stops (an ambiguous append,
// BR-RUA-033) cleanup goes on, and the first refusal becomes one reason on the current step.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CleanupActionBody } from '../../../src/cleanup/cleanup-action-fold.ts';
import { CleanupJournal } from '../../../src/cleanup/cleanup-journal.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { EPOCH_MS, EXECUTION, MANIFEST_SHA } from '../../support/cleanup/cleanup-fixtures.ts';
import { MemoryAppendOnlyFile } from '../../support/event-journal/memory-append-only-file.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const PATH = 'cleanup/cleanup-journal.jsonl';

function journalOver(file: MemoryAppendOnlyFile): {
  readonly journal: CleanupJournal;
  readonly time: VirtualTimeScheduler;
} {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const writer = new JournalWriter({
    port: createJsonlJournalPort(PATH, file),
    source: 'cleanup',
    instanceId: 'cccccccc-0000-4000-8000-000000000001' as Uuid4,
    scope: { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA, partition: { kind: 'execution' } },
    clock: time,
    ids: new SequentialUuidSource('eeeeeeee'),
    maxDefinitiveRetries: 0,
  });
  return { journal: new CleanupJournal(writer, time), time };
}

function body(step: number, reasons: CleanupActionBody['reasons'] = []): CleanupActionBody {
  return {
    step,
    step_status: 'started',
    cleanup_mode: 'NORMAL',
    cleanup_induced: false,
    action: 'CONSUMERS_DISABLE',
    reasons,
  };
}

describe('CleanupJournal', () => {
  it('appends each action and keeps it in memory with its event time', async () => {
    const file = new MemoryAppendOnlyFile();
    const { journal } = journalOver(file);
    await journal.record(body(3));
    assert.equal(journal.entries().length, 1);
    assert.equal(journal.entries()[0]?.occurred_at, '2026-10-05T12:00:00.000Z');
    assert.match(file.text(PATH) ?? '', /"record_type":"cleanup_action_recorded"/);
    assert.deepEqual(journal.takeFailure(), []);
  });

  it('makes every reason schema-conforming before it is journaled', async () => {
    const file = new MemoryAppendOnlyFile();
    const { journal } = journalOver(file);
    await journal.record(body(9, [{ code: 'ResourceInUseException', subject: 't', detail: 'in use' }]));
    assert.equal(journal.entries()[0]?.body.reasons[0]?.code, 'RESOURCE_IN_USE_EXCEPTION');
    assert.match(file.text(PATH) ?? '', /"code":"RESOURCE_IN_USE_EXCEPTION"/);
  });

  it('keeps recording in memory after the journal stops, reporting the stop once', async () => {
    const file = new MemoryAppendOnlyFile();
    file.failWriteAt(PATH, 2, 'written_unacknowledged');
    const { journal } = journalOver(file);
    await journal.record(body(1));
    await journal.record(body(2));
    await journal.record(body(3));
    assert.deepEqual(
      journal.entries().map((entry) => entry.body.step),
      [1, 2, 3],
    );
    const [failure, ...rest] = journal.takeFailure();
    assert.equal(rest.length, 0);
    assert.equal(failure?.code, 'CLEANUP_JOURNAL_STOPPED');
    assert.match(failure.detail, /append of CONSUMERS_DISABLE for step 2 returned AMBIGUOUS_APPEND: .*ambiguous EIO/);
    assert.deepEqual(journal.takeFailure(), [], 'the failure is attached once');
    await journal.record(body(4));
    assert.deepEqual(journal.takeFailure(), [], 'later refusals are not reported again');
  });

  it('returns a copy of its entries', async () => {
    const { journal } = journalOver(new MemoryAppendOnlyFile());
    await journal.record(body(1));
    const copy = journal.entries() as unknown[];
    copy.pop();
    assert.equal(journal.entries().length, 1);
  });
});
