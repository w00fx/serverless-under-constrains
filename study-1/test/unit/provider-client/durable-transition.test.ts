// runDurableTransition (design §5.3 C1-C3, BR-RUA-021, BR-RUA-033): each transaction outcome
// maps to what the evidence proves, and the journal writer is settled with that outcome so a
// lost or conflicting write stops the instance.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import type { PreparedJournalPut } from '../../../src/event-journal/journal-writer.ts';
import { runDurableTransition } from '../../../src/provider-client/durable-transition.ts';
import type { TransitionResult } from '../../../src/provider-client/durable-transition.ts';
import { CAUSE_LOW, dispatchStartedBody, writerHarness } from '../../support/event-journal/journal-fixtures.ts';
import type { WriterHarness } from '../../support/event-journal/journal-fixtures.ts';

interface TransitionRun {
  readonly result: TransitionResult;
  readonly puts: readonly PreparedJournalPut[];
}

async function transitionWith(
  harness: WriterHarness,
  outcomeOf: (put: PreparedJournalPut) => Promise<WriteOutcome>,
): Promise<TransitionRun> {
  const puts: PreparedJournalPut[] = [];
  const result = await runDurableTransition(
    harness.writer,
    'dispatch_started',
    dispatchStartedBody(),
    [CAUSE_LOW],
    (put) => {
      puts.push(put);
      return outcomeOf(put);
    },
  );
  return { result, puts };
}

describe('runDurableTransition', () => {
  it('an applied transaction yields the reserved event and advances the journal', async () => {
    const harness = writerHarness();
    const { result, puts } = await transitionWith(harness, () => Promise.resolve({ kind: 'applied' }));
    const [put, ...others] = puts;
    assert.ok(put !== undefined && others.length === 0);
    assert.deepEqual(result, { kind: 'applied', event: put.event });
    assert.equal(put.event.record_type, 'dispatch_started');
    assert.deepEqual(put.event.causation_event_ids, [CAUSE_LOW]);
    assert.equal(put.event.source_sequence, 1);
    const next = await transitionWith(harness, () => Promise.resolve({ kind: 'applied' }));
    assert.equal(next.puts[0]?.event.source_sequence, 2);
  });

  it('a definitive failure is rejected and frees the sequence', async () => {
    const harness = writerHarness();
    const failed = await transitionWith(harness, () =>
      Promise.resolve({ kind: 'definitive_failure', code: 'ValidationException' }),
    );
    assert.deepEqual(failed.result, { kind: 'rejected' });
    assert.equal(harness.writer.isStopped(), false);
    const next = await transitionWith(harness, () => Promise.resolve({ kind: 'applied' }));
    assert.equal(next.puts[0]?.event.source_sequence, 1);
  });

  it('a failed state condition is condition_failed and leaves the writer running', async () => {
    const harness = writerHarness();
    const { result } = await transitionWith(harness, () =>
      Promise.resolve({
        kind: 'condition_failed',
        failed_action_index: 1,
        existing: { pk: 'p', sk: 'state#attempt#x' },
      }),
    );
    assert.deepEqual(result, { kind: 'condition_failed' });
    assert.equal(harness.writer.isStopped(), false);
  });

  it('another event at the journal key is condition_failed and stops the writer (SEQUENCE_CONFLICT)', async () => {
    const harness = writerHarness();
    const { result } = await transitionWith(harness, (put) =>
      Promise.resolve({
        kind: 'condition_failed',
        failed_action_index: 0,
        existing: { ...put.item, event_id: 'ffffffff-0000-4000-8000-000000000001' },
      }),
    );
    assert.deepEqual(result, { kind: 'condition_failed' });
    assert.equal(harness.writer.isStopped(), true);
  });

  it('the same event already at the journal key counts as applied', async () => {
    const harness = writerHarness();
    const { result, puts } = await transitionWith(harness, (put) =>
      Promise.resolve({ kind: 'condition_failed', failed_action_index: 0, existing: put.item }),
    );
    assert.deepEqual(result, { kind: 'applied', event: puts[0]?.event });
  });

  it('an ambiguous outcome or a throwing port is ambiguous and stops the writer', async () => {
    const lost = writerHarness();
    const ambiguous = await transitionWith(lost, () => Promise.resolve({ kind: 'ambiguous', code: 'RequestTimeout' }));
    assert.deepEqual(ambiguous.result, { kind: 'ambiguous' });
    assert.equal(lost.writer.isStopped(), true);

    const broken = writerHarness();
    const thrown = await transitionWith(broken, () => Promise.reject(new Error('port defect')));
    assert.deepEqual(thrown.result, { kind: 'ambiguous' });
    assert.equal(broken.writer.isStopped(), true);
  });

  it('a stopped writer is ambiguous without calling the port', async () => {
    const harness = writerHarness();
    await transitionWith(harness, () => Promise.resolve({ kind: 'ambiguous', code: 'RequestTimeout' }));
    const { result, puts } = await transitionWith(harness, () => Promise.resolve({ kind: 'applied' }));
    assert.deepEqual(result, { kind: 'ambiguous' });
    assert.deepEqual(puts, []);
  });
});
