// runDurableTransition (design §5.3 C1-C3, BR-RUA-021, BR-RUA-033): each transaction outcome
// maps to what the evidence proves, and the journal writer is settled with that outcome so a
// lost or conflicting write stops the instance. A definitive failure is retried with the
// identical put (same event identity, content and sequence) up to the writer's budget
// (BR-RUA-033 "retries a definitive failed append"; WP-06 review round 2).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import type { PreparedJournalPut } from '../../../src/event-journal/journal-writer.ts';
import { PORT_THREW_CODE, runDurableTransition } from '../../../src/provider-client/durable-transition.ts';
import type { TransitionResult } from '../../../src/provider-client/durable-transition.ts';
import { CAUSE_LOW, dispatchStartedBody, writerHarness } from '../../support/event-journal/journal-fixtures.ts';
import type { WriterHarness } from '../../support/event-journal/journal-fixtures.ts';

interface TransitionRun {
  readonly result: TransitionResult;
  readonly puts: readonly PreparedJournalPut[];
}

async function transitionWith(
  harness: WriterHarness,
  outcomeOf: (put: PreparedJournalPut, call: number) => Promise<WriteOutcome>,
  maxDefinitiveRetries = 0,
): Promise<TransitionRun> {
  const puts: PreparedJournalPut[] = [];
  const result = await runDurableTransition(harness.writer, maxDefinitiveRetries, {
    type: 'dispatch_started',
    body: dispatchStartedBody(),
    causation: [CAUSE_LOW],
    write: (put) => {
      puts.push(put);
      return outcomeOf(put, puts.length);
    },
  });
  return { result, puts };
}

const THROTTLED: WriteOutcome = { kind: 'definitive_failure', code: 'ThrottlingException' };

// The detail of the next prepare on a stopped writer repeats the reason it stopped.
function stopDetail(harness: WriterHarness): string {
  const next = harness.writer.prepare('dispatch_started', dispatchStartedBody(), [CAUSE_LOW]);
  assert.ok(next.kind === 'stopped', next.kind);
  return next.detail;
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

  // Regression (WP-06 review round 2): the caught value was discarded, so a defective port left
  // no trace. The bounded name and message now reach the stopped writer's detail.
  it('names what a throwing port threw in the stopped writer detail, bounded', async () => {
    assert.equal(PORT_THREW_CODE, 'ATTEMPT_STATE_PORT_THREW');
    const typeError = writerHarness();
    const typeErrorRun = await transitionWith(typeError, () => Promise.reject(new TypeError('x is not a function')));
    assert.deepEqual(typeErrorRun.result, { kind: 'ambiguous' });
    const key = typeErrorRun.puts[0]?.key.sk ?? '';
    assert.equal(
      stopDetail(typeError),
      `stopped earlier by AMBIGUOUS_APPEND: ${key}: ambiguous ATTEMPT_STATE_PORT_THREW: "TypeError" "x is not a function"; the event may or may not be stored`,
    );

    const huge = writerHarness();
    await transitionWith(huge, () => Promise.reject(new Error('M'.repeat(500_000))));
    const detail = stopDetail(huge);
    assert.ok(detail.includes(`"Error" "${'M'.repeat(199)}…[truncated]; the event`), detail.slice(0, 300));
    assert.ok(detail.length < 600, String(detail.length));

    const nonError = writerHarness();
    await transitionWith(nonError, () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- a defective port may throw any value
      throw 'plain string';
    });
    assert.match(stopDetail(nonError), /ambiguous ATTEMPT_STATE_PORT_THREW: "NonErrorThrown" "plain string"; /u);
  });

  it('a stopped writer is ambiguous without calling the port', async () => {
    const harness = writerHarness();
    await transitionWith(harness, () => Promise.resolve({ kind: 'ambiguous', code: 'RequestTimeout' }));
    const { result, puts } = await transitionWith(harness, () => Promise.resolve({ kind: 'applied' }));
    assert.deepEqual(result, { kind: 'ambiguous' });
    assert.deepEqual(puts, []);
  });
});

describe('runDurableTransition identical retries (BR-RUA-033)', () => {
  it('retries a definitive failure with the identical put and applies within the budget', async () => {
    const harness = writerHarness();
    const { result, puts } = await transitionWith(
      harness,
      (_put, call) => Promise.resolve(call <= 2 ? THROTTLED : { kind: 'applied' }),
      2,
    );
    assert.equal(puts.length, 3);
    const [first, ...retries] = puts;
    assert.ok(first !== undefined);
    // The same reserved put each time: identical event identity, content and sequence.
    for (const retry of retries) {
      assert.equal(retry, first);
    }
    assert.equal(first.event.source_sequence, 1);
    assert.deepEqual(result, { kind: 'applied', event: first.event });
    const next = await transitionWith(harness, () => Promise.resolve({ kind: 'applied' }));
    assert.equal(next.puts[0]?.event.source_sequence, 2);
  });

  it('is rejected after budget + 1 definitive failures, and the sequence stays free', async () => {
    const harness = writerHarness();
    const { result, puts } = await transitionWith(harness, () => Promise.resolve(THROTTLED), 2);
    assert.equal(puts.length, 3);
    assert.deepEqual(result, { kind: 'rejected' });
    assert.equal(harness.writer.isStopped(), false);
    const next = await transitionWith(harness, () => Promise.resolve({ kind: 'applied' }));
    assert.equal(next.puts[0]?.event.source_sequence, 1);
  });

  it('with a budget of 0 a definitive failure is rejected after one try', async () => {
    const harness = writerHarness();
    const { result, puts } = await transitionWith(harness, () => Promise.resolve(THROTTLED), 0);
    assert.equal(puts.length, 1);
    assert.deepEqual(result, { kind: 'rejected' });
  });

  it('never retries a failed condition or an ambiguous outcome', async () => {
    const conditional = writerHarness();
    const failedCondition = await transitionWith(
      conditional,
      () => Promise.resolve({ kind: 'condition_failed', failed_action_index: 1, existing: { pk: 'p', sk: 's' } }),
      2,
    );
    assert.equal(failedCondition.puts.length, 1);
    assert.deepEqual(failedCondition.result, { kind: 'condition_failed' });

    const lost = writerHarness();
    const ambiguous = await transitionWith(
      lost,
      () => Promise.resolve({ kind: 'ambiguous', code: 'RequestTimeout' }),
      2,
    );
    assert.equal(ambiguous.puts.length, 1);
    assert.deepEqual(ambiguous.result, { kind: 'ambiguous' });
  });

  it('an ambiguous retry stops the writer and is ambiguous', async () => {
    const harness = writerHarness();
    const { result, puts } = await transitionWith(
      harness,
      (_put, call) => Promise.resolve(call === 1 ? THROTTLED : { kind: 'ambiguous', code: 'RequestTimeout' }),
      2,
    );
    assert.equal(puts.length, 2);
    assert.deepEqual(result, { kind: 'ambiguous' });
    assert.equal(harness.writer.isStopped(), true);
  });
});
