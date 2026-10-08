// BR-RUA-033 append semantics of JournalWriter.append: dense sequences from 1, serialized
// appends, identical retries of definitive failures, and a permanent stop after an ambiguous
// result. The writer runs over the real journal-table port on InMemoryItemStore (scripted
// faults) or the JSONL port on MemoryAppendOnlyFile, behind a recording port.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toJournalEntry } from '../../../src/event-journal/journal-entry.ts';
import { buildJournalEvent } from '../../../src/event-journal/journal-event.ts';
import { journalItemKey } from '../../../src/event-journal/journal-scope.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import type { Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import {
  CAUSE_HIGH,
  CAUSE_LOW,
  dispatchStartedBody,
  EPOCH_UTC,
  INSTANCE_ID,
  JSONL_PATH,
  TRIAL_SCOPE,
  writerHarness,
  appendedEvent,
  refundRequestIdOf,
} from '../../support/event-journal/journal-fixtures.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { RecordingJournalAppendPort } from '../../support/event-journal/recording-journal-append-port.ts';
import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import { parseJsonl } from '../../../src/record-contract/parsing.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';

const FIRST_EVENT_ID = 'eeeeeeee-0000-4000-8000-000000000001' as Uuid4;
const RESTARTED_INSTANCE_ID = 'cccccccc-0000-4000-8000-000000000009' as Uuid4;
const SK1 = journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, 1).sk;
const SK2 = journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, 2).sk;

function storedSequences(harness: ReturnType<typeof writerHarness>): readonly number[] {
  return harness.store.itemsIn('caller_journal').map((item) => item['source_sequence'] as number);
}

describe('JournalWriter.append', () => {
  it('numbers events densely from 1 and stores each under its key', async () => {
    const harness = writerHarness();
    const results = [];
    for (const n of [1, 2, 3]) {
      results.push(await harness.writer.append('dispatch_started', dispatchStartedBody(n)));
      await harness.time.advanceBy(5);
    }
    assert.deepEqual(
      results.map((result) => (result.kind === 'appended' ? result.event.source_sequence : result.reason)),
      [1, 2, 3],
    );
    assert.deepEqual(storedSequences(harness), [1, 2, 3]);
    const [first, , third] = results.map(appendedEvent);
    assert.ok(first !== undefined && third !== undefined);
    assert.equal(first.event_id, FIRST_EVENT_ID);
    assert.equal(first.occurred_at, EPOCH_UTC);
    const key = journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, 1);
    assert.deepEqual(harness.store.peek('caller_journal', key), { ...first, ...key });
    assert.equal(third.occurred_at, '2026-10-05T12:00:00.010Z');
    assert.equal(harness.writer.isStopped(), false);
  });

  it('serializes concurrent appends in call order', async () => {
    const harness = writerHarness();
    const results = await Promise.all(
      [1, 2, 3].map((n) => harness.writer.append('dispatch_started', dispatchStartedBody(n))),
    );
    assert.deepEqual(
      results.map((result) => [appendedEvent(result).source_sequence, refundRequestIdOf(appendedEvent(result))]),
      [
        [1, 'ref-poc-001'],
        [2, 'ref-poc-002'],
        [3, 'ref-poc-003'],
      ],
    );
    assert.deepEqual(
      harness.port.entries().map((entry) => entry.key.sk.slice(-3)),
      ['001', '002', '003'],
    );
  });

  it('sorts and deduplicates causation', async () => {
    const harness = writerHarness();
    const result = await harness.writer.append('dispatch_started', dispatchStartedBody(), [
      CAUSE_HIGH,
      CAUSE_LOW,
      CAUSE_LOW,
    ]);
    assert.deepEqual(appendedEvent(result).causation_event_ids, [CAUSE_LOW, CAUSE_HIGH]);
  });

  it('retries a definitive failure with identical identity, content and sequence', async () => {
    const harness = writerHarness({ maxDefinitiveRetries: 2 });
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ProvisionedThroughputExceededException' });
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ThrottlingException' });
    const result = await harness.writer.append('dispatch_started', dispatchStartedBody());
    assert.equal(result.kind, 'appended');
    const sent = harness.port.entries();
    assert.equal(sent.length, 3);
    assert.deepEqual(sent[1], sent[0]);
    assert.deepEqual(sent[2], sent[0]);
    assert.equal(harness.ids.issuedCount(), 1);
    assert.deepEqual(storedSequences(harness), [1]);
    const next = await harness.writer.append('dispatch_started', dispatchStartedBody(2));
    assert.equal(appendedEvent(next).source_sequence, 2);
  });

  it('stops with DEFINITIVE_RETRIES_EXHAUSTED once every identical retry failed', async () => {
    const harness = writerHarness({ maxDefinitiveRetries: 2 });
    for (let fault = 0; fault < 3; fault += 1) {
      harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ThrottlingException' });
    }
    const exhausted = `${SK1}: 3 identical attempt(s) failed definitively; last outcome definitive_failure ThrottlingException`;
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody()), {
      kind: 'stopped',
      reason: 'DEFINITIVE_RETRIES_EXHAUSTED',
      detail: exhausted,
    });
    assert.equal(harness.port.entries().length, 3);
    assert.equal(harness.writer.isStopped(), true);
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody(2)), {
      kind: 'stopped',
      reason: 'INSTANCE_ALREADY_STOPPED',
      detail: `stopped earlier by DEFINITIVE_RETRIES_EXHAUSTED: ${exhausted}`,
    });
    assert.equal(harness.port.entries().length, 3);
    assert.deepEqual(storedSequences(harness), []);
  });

  it('with no retries allowed, one definitive failure stops the instance', async () => {
    const harness = writerHarness({ maxDefinitiveRetries: 0 });
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ThrottlingException' });
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody()), {
      kind: 'stopped',
      reason: 'DEFINITIVE_RETRIES_EXHAUSTED',
      detail: `${SK1}: 1 identical attempt(s) failed definitively; last outcome definitive_failure ThrottlingException`,
    });
    assert.equal(harness.port.entries().length, 1);
  });

  for (const applied of [false, true]) {
    it(`an ambiguous append (${applied ? 'applied' : 'not applied'}) stops the instance for good`, async () => {
      const harness = writerHarness();
      harness.store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied });
      const ambiguous = `${SK1}: ambiguous TimeoutError; the event may or may not be stored`;
      assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody()), {
        kind: 'stopped',
        reason: 'AMBIGUOUS_APPEND',
        detail: ambiguous,
      });
      assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody(2)), {
        kind: 'stopped',
        reason: 'INSTANCE_ALREADY_STOPPED',
        detail: `stopped earlier by AMBIGUOUS_APPEND: ${ambiguous}`,
      });
      assert.equal(harness.port.entries().length, 1);
      assert.deepEqual(storedSequences(harness), applied ? [1] : []);
    });
  }

  it('an identical event already at its key counts as appended', async () => {
    const harness = writerHarness();
    const key = journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, 1);
    const landed = buildJournalEvent('dispatch_started', dispatchStartedBody(), {
      scope: TRIAL_SCOPE,
      source: 'conventional_caller',
      source_instance_id: INSTANCE_ID,
      source_sequence: 1,
      event_id: FIRST_EVENT_ID,
      occurred_at: EPOCH_UTC,
      causation: [],
    });
    harness.store.seed('caller_journal', toJournalEntry(key, landed).item);
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody()), {
      kind: 'appended',
      event: landed,
    });
    const next = await harness.writer.append('dispatch_started', dispatchStartedBody(2));
    assert.equal(appendedEvent(next).source_sequence, 2);
  });

  it('other content at its key stops the instance with SEQUENCE_CONFLICT', async () => {
    const harness = writerHarness();
    const key = journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, 1);
    harness.store.seed('caller_journal', { ...key, record_type: 'dispatch_started', event_id: CAUSE_LOW });
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody()), {
      kind: 'stopped',
      reason: 'SEQUENCE_CONFLICT',
      detail: `${SK1}: condition_failed at action 0; other content occupies this sequence`,
    });
    assert.equal(harness.writer.isStopped(), true);
    assert.equal(harness.port.entries().length, 1);
  });

  it('a condition failure without a decodable existing item is a SEQUENCE_CONFLICT, never retried', async () => {
    // The journal put's only condition is item_absent, so its failure proves the key is
    // occupied; WP-04 omits `existing` when the ALL_OLD image does not decode.
    const harness = writerHarness({ maxDefinitiveRetries: 2 });
    harness.port.answerNext({ kind: 'condition_failed', failed_action_index: 0 });
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody()), {
      kind: 'stopped',
      reason: 'SEQUENCE_CONFLICT',
      detail: `${SK1}: condition_failed at action 0 without a decodable existing item; other content occupies this sequence`,
    });
    assert.equal(harness.port.entries().length, 1);
    assert.deepEqual(storedSequences(harness), []);
  });

  for (const thrown of [new TypeError('socket hang up'), 'a string']) {
    it(`a port that throws (${typeof thrown}) is treated as an ambiguous append`, async () => {
      const harness = writerHarness();
      harness.port.throwNext(thrown);
      assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody()), {
        kind: 'stopped',
        reason: 'AMBIGUOUS_APPEND',
        detail: `${SK1}: port threw ${thrown instanceof Error ? 'TypeError: socket hang up' : 'a non-Error string'}; the event may or may not be stored`,
      });
      assert.deepEqual(harness.port.outcomes(), []);
      assert.equal(harness.writer.isStopped(), true);
    });
  }

  it('writes JSONL lines and stops after a finalized file refuses every retry', async () => {
    const harness = writerHarness({ medium: 'jsonl', maxDefinitiveRetries: 1 });
    assert.equal((await harness.writer.append('dispatch_started', dispatchStartedBody())).kind, 'appended');
    await harness.file.finalize(JSONL_PATH);
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody(2)), {
      kind: 'stopped',
      reason: 'DEFINITIVE_RETRIES_EXHAUSTED',
      detail: `${SK2}: 2 identical attempt(s) failed definitively; last outcome definitive_failure FILE_FINALIZED`,
    });
    assert.equal(harness.file.text(JSONL_PATH)?.split('\n').length, 2);
    assert.equal(harness.port.entries().length, 3);
  });

  it('a torn JSONL write is ambiguous and stops the instance', async () => {
    const harness = writerHarness({ medium: 'jsonl' });
    harness.file.failWriteAt(JSONL_PATH, 2, 'torn_write');
    assert.equal((await harness.writer.append('dispatch_started', dispatchStartedBody())).kind, 'appended');
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody(2)), {
      kind: 'stopped',
      reason: 'AMBIGUOUS_APPEND',
      detail: `${SK2}: ambiguous EIO; the event may or may not be stored`,
    });
  });

  it('a restarted instance keeps journaling to a JSONL file after a torn write (BR-RUA-033)', async () => {
    const harness = writerHarness({ medium: 'jsonl' });
    harness.file.failWriteAt(JSONL_PATH, 2, 'torn_write');
    appendedEvent(await harness.writer.append('dispatch_started', dispatchStartedBody()));
    assert.equal((await harness.writer.append('dispatch_started', dispatchStartedBody(2))).kind, 'stopped');
    const restarted = new JournalWriter({
      port: createJsonlJournalPort(JSONL_PATH, harness.file),
      source: 'conventional_caller',
      instanceId: RESTARTED_INSTANCE_ID,
      scope: TRIAL_SCOPE,
      clock: harness.time,
      ids: new SequentialUuidSource('77777777'),
      maxDefinitiveRetries: 2,
    });
    const first = appendedEvent(await restarted.append('dispatch_started', dispatchStartedBody(3)));
    const second = appendedEvent(await restarted.append('dispatch_started', dispatchStartedBody(4)));
    assert.deepEqual([first.source_sequence, second.source_sequence], [1, 2]);
    const report = parseJsonl(harness.file.contents(JSONL_PATH) ?? new Uint8Array(0));
    assert.equal(report.ends_with_newline, true);
    // Line 2 is the torn fragment alone: malformed, never merged into the restarted record.
    assert.deepEqual(
      report.lines.map((line) =>
        line.parsed.ok ? (line.parsed.value as { source_instance_id: string }).source_instance_id : 'malformed',
      ),
      [INSTANCE_ID, 'malformed', RESTARTED_INSTANCE_ID, RESTARTED_INSTANCE_ID],
    );
    assert.equal(restarted.isStopped(), false);
  });

  it('refuses a retry budget that is not a nonnegative safe integer', () => {
    const time = new VirtualTimeScheduler({ wallEpochMs: 0 });
    const port = new RecordingJournalAppendPort(
      createDurableJournalPort(new InMemoryItemStore({ clock: time }), 'caller_journal'),
    );
    for (const invalid of [-1, 1.5, Number.NaN]) {
      assert.throws(
        () =>
          new JournalWriter({
            port,
            source: 'runner',
            instanceId: INSTANCE_ID,
            scope: TRIAL_SCOPE,
            clock: time,
            ids: new SequentialUuidSource(),
            maxDefinitiveRetries: invalid,
          }),
        { name: 'RangeError', message: `maxDefinitiveRetries ${String(invalid)}; expected a nonnegative safe integer` },
      );
    }
  });

  it('formats occurred_at from the injected wall clock', async () => {
    const harness = writerHarness();
    await harness.time.advanceBy(1234);
    const result = await harness.writer.append('dispatch_started', dispatchStartedBody());
    assert.equal(appendedEvent(result).occurred_at, '2026-10-05T12:00:01.234Z' as UtcMillis);
  });
});
