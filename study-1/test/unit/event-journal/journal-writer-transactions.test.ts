// JournalWriter.prepare / confirm: an event written inside a caller-owned transaction (design
// §5.3 C1-C3, D-23). An applied transaction advances the sequence; an ambiguous one stops the
// instance (BR-RUA-033); a transaction that was definitively not applied leaves no event, so
// the next event reuses the sequence and the persisted sequence stays dense, unless the caller
// resubmits the identical put through prepareRetry (BR-RUA-033 identical retry).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WriteAction } from '../../../src/durable-store/item-store-port.ts';
import { journalPutAction } from '../../../src/event-journal/journal-entry.ts';
import type { PreparedJournalPut } from '../../../src/event-journal/journal-writer.ts';
import { TOKEN } from '../../support/durable-store/item-store-fixtures.ts';
import {
  ATTEMPT_ID,
  CAUSE_HIGH,
  CAUSE_LOW,
  dispatchStartedBody,
  TRIAL_SCOPE,
  writerHarness,
  appendedEvent,
} from '../../support/event-journal/journal-fixtures.ts';
import type { WriterHarness } from '../../support/event-journal/journal-fixtures.ts';

const ATTEMPT_KEY = { pk: 'p', sk: `state#attempt#${ATTEMPT_ID}` };
const TO_DISPATCHED: WriteAction = {
  kind: 'update',
  table: 'caller_journal',
  key: ATTEMPT_KEY,
  set: { phase: 'DISPATCHED' },
  condition: { kind: 'attribute_equals', name: 'phase', value: 'PRE_DISPATCH' },
};

function prepared(
  harness: WriterHarness,
  n = 1,
  causation: Parameters<WriterHarness['writer']['prepare']>[2] = [],
): PreparedJournalPut {
  const result = harness.writer.prepare('dispatch_started', dispatchStartedBody(n), causation);
  if (result.kind !== 'prepared') {
    throw new Error(`prepare returned ${JSON.stringify(result)}; expected a prepared put`);
  }
  return result.put;
}

function dispatchTransaction(put: PreparedJournalPut): readonly WriteAction[] {
  return [journalPutAction('caller_journal', put), TO_DISPATCHED];
}

describe('JournalWriter.prepare and confirm', () => {
  it('an applied transaction appends the event and advances the sequence', async () => {
    const harness = writerHarness();
    harness.store.seed('caller_journal', { ...ATTEMPT_KEY, phase: 'PRE_DISPATCH' });
    const put = prepared(harness, 1, [CAUSE_HIGH, CAUSE_LOW]);
    assert.equal(put.event.source_sequence, 1);
    assert.deepEqual(put.event.causation_event_ids, [CAUSE_LOW, CAUSE_HIGH]);
    assert.equal(harness.store.peek('caller_journal', put.key), undefined);
    const outcome = await harness.store.transact(dispatchTransaction(put), TOKEN);
    assert.deepEqual(harness.writer.confirm(put, outcome), { kind: 'appended', event: put.event });
    assert.deepEqual(harness.store.peek('caller_journal', put.key), put.item);
    const next = await harness.writer.append('dispatch_started', dispatchStartedBody(2));
    assert.equal(appendedEvent(next).source_sequence, 2);
  });

  it('a failed transaction condition leaves no event and frees the sequence', async () => {
    const harness = writerHarness();
    harness.store.seed('caller_journal', { ...ATTEMPT_KEY, phase: 'NOT_DISPATCHED' });
    const put = prepared(harness);
    const outcome = await harness.store.transact(dispatchTransaction(put), TOKEN);
    assert.equal(outcome.kind, 'condition_failed');
    assert.deepEqual(harness.writer.confirm(put, outcome), { kind: 'not_applied', event: put.event, outcome });
    assert.equal(harness.writer.isStopped(), false);
    const next = await harness.writer.append('dispatch_started', dispatchStartedBody(2));
    assert.equal(appendedEvent(next).source_sequence, 1);
  });

  it('a definitive transaction failure leaves no event and frees the sequence', async () => {
    const harness = writerHarness();
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ValidationException' });
    const put = prepared(harness);
    const outcome = await harness.store.transact(dispatchTransaction(put), TOKEN);
    assert.deepEqual(harness.writer.confirm(put, outcome), { kind: 'not_applied', event: put.event, outcome });
    const again = prepared(harness, 2);
    assert.equal(again.event.source_sequence, 1);
    assert.notEqual(again.event.event_id, put.event.event_id);
  });

  it('an ambiguous transaction stops the instance; prepare and append then report the stop', async () => {
    const harness = writerHarness();
    const put = prepared(harness);
    const ambiguous = `${put.key.sk}: ambiguous TimeoutError; the event may or may not be stored`;
    const already = {
      kind: 'stopped',
      reason: 'INSTANCE_ALREADY_STOPPED',
      detail: `stopped earlier by AMBIGUOUS_APPEND: ${ambiguous}`,
    };
    assert.deepEqual(harness.writer.confirm(put, { kind: 'ambiguous', code: 'TimeoutError' }), {
      kind: 'stopped',
      reason: 'AMBIGUOUS_APPEND',
      detail: ambiguous,
    });
    assert.deepEqual(harness.writer.prepare('dispatch_started', dispatchStartedBody(2)), already);
    assert.deepEqual(await harness.writer.append('dispatch_started', dispatchStartedBody(2)), already);
    assert.deepEqual(harness.writer.prepareRetry(put), already);
    assert.equal(harness.port.entries().length, 0);
  });

  it('a condition failure on the identical entry is appended, on other content a sequence conflict', () => {
    const landed = writerHarness();
    const put = prepared(landed);
    assert.deepEqual(
      landed.writer.confirm(put, { kind: 'condition_failed', failed_action_index: 0, existing: { ...put.item } }),
      { kind: 'appended', event: put.event },
    );
    const conflicting = writerHarness();
    const other = prepared(conflicting);
    assert.deepEqual(
      conflicting.writer.confirm(other, {
        kind: 'condition_failed',
        failed_action_index: 0,
        existing: { ...other.item, refund_request_id: 'ref-poc-999' },
      }),
      {
        kind: 'stopped',
        reason: 'SEQUENCE_CONFLICT',
        detail: `${other.key.sk}: condition_failed at action 0; other content occupies this sequence`,
      },
    );
    assert.equal(conflicting.writer.isStopped(), true);
  });

  it('with the put index, a failed condition on the put itself is a sequence conflict even without an existing item', () => {
    const harness = writerHarness();
    const put = prepared(harness);
    assert.deepEqual(harness.writer.confirm(put, { kind: 'condition_failed', failed_action_index: 0 }, 0), {
      kind: 'stopped',
      reason: 'SEQUENCE_CONFLICT',
      detail: `${put.key.sk}: condition_failed at action 0 without a decodable existing item; other content occupies this sequence`,
    });
  });

  it('with the put index, a failed condition on another action is not applied', () => {
    const harness = writerHarness();
    const put = prepared(harness);
    const outcome = { kind: 'condition_failed', failed_action_index: 1 } as const;
    assert.deepEqual(harness.writer.confirm(put, outcome, 0), { kind: 'not_applied', event: put.event, outcome });
    assert.equal(harness.writer.isStopped(), false);
  });

  it('prepareRetry resubmits a not-applied put with identical identity, content and sequence', async () => {
    const harness = writerHarness();
    harness.store.seed('caller_journal', { ...ATTEMPT_KEY, phase: 'PRE_DISPATCH' });
    harness.store.scriptWriteFault({ kind: 'definitive_failure', code: 'ThrottlingException' });
    const put = prepared(harness);
    const failed = await harness.store.transact(dispatchTransaction(put), TOKEN);
    assert.equal(harness.writer.confirm(put, failed).kind, 'not_applied');
    assert.deepEqual(harness.writer.prepareRetry(put), { kind: 'prepared', put });
    const outcome = await harness.store.transact(dispatchTransaction(put), TOKEN);
    assert.deepEqual(harness.writer.confirm(put, outcome), { kind: 'appended', event: put.event });
    assert.deepEqual(harness.store.peek('caller_journal', put.key), put.item);
    assert.equal(harness.ids.issuedCount(), 1);
    assert.equal(
      appendedEvent(await harness.writer.append('dispatch_started', dispatchStartedBody(2))).source_sequence,
      2,
    );
  });

  it('prepareRetry refuses any put but the last not-applied one, and after another event was prepared', () => {
    const harness = writerHarness();
    const put = prepared(harness);
    assert.throws(() => harness.writer.prepareRetry(put), {
      name: 'Error',
      message: `prepareRetry(${put.key.sk}) with 0 pending append(s) and reservation ${put.key.sk}; expected an idle writer`,
    });
    harness.writer.confirm(put, { kind: 'definitive_failure', code: 'ValidationException' });
    assert.throws(() => harness.writer.prepareRetry({ ...put }), {
      name: 'Error',
      message: `prepareRetry() for ${put.key.sk} (retryable: ${put.key.sk}); expected the last put that confirm() reported not_applied, before any other event`,
    });
    const replanned = prepared(harness, 2);
    harness.writer.confirm(replanned, { kind: 'applied' });
    assert.throws(() => harness.writer.prepareRetry(put), {
      name: 'Error',
      message: `prepareRetry() for ${put.key.sk} (retryable: none); expected the last put that confirm() reported not_applied, before any other event`,
    });
  });

  it('a retried put is no longer retryable once it is reserved again', () => {
    const harness = writerHarness();
    const put = prepared(harness);
    harness.writer.confirm(put, { kind: 'definitive_failure', code: 'ValidationException' });
    harness.writer.prepareRetry(put);
    harness.writer.confirm(put, { kind: 'applied' });
    assert.throws(() => harness.writer.prepareRetry(put), {
      name: 'Error',
      message: `prepareRetry() for ${put.key.sk} (retryable: none); expected the last put that confirm() reported not_applied, before any other event`,
    });
  });

  it('confirm refuses a put that is not the outstanding reservation', () => {
    const harness = writerHarness();
    const put = prepared(harness);
    const copy = { ...put };
    assert.throws(() => harness.writer.confirm(copy, { kind: 'applied' }), {
      name: 'Error',
      message: `confirm() for ${put.key.sk} without its reservation (outstanding: ${put.key.sk}); expected the put returned by the last prepare()`,
    });
    harness.writer.confirm(put, { kind: 'applied' });
    assert.throws(() => harness.writer.confirm(put, { kind: 'applied' }), {
      name: 'Error',
      message: `confirm() for ${put.key.sk} without its reservation (outstanding: none); expected the put returned by the last prepare()`,
    });
  });

  it('appends are serialized: no prepare or append while a put is reserved or an append is pending', async () => {
    const harness = writerHarness();
    const put = prepared(harness);
    assert.throws(() => harness.writer.prepare('dispatch_started', dispatchStartedBody(2)), {
      name: 'Error',
      message: `prepare(dispatch_started) with 0 pending append(s) and reservation ${put.key.sk}; expected an idle writer`,
    });
    await assert.rejects(harness.writer.append('dispatch_started', dispatchStartedBody(2)), {
      name: 'Error',
      message: `append(dispatch_started) while the put ${put.key.sk} is reserved; expected confirm() before the next append`,
    });
    harness.writer.confirm(put, { kind: 'applied' });
    const pending = harness.writer.append('dispatch_started', dispatchStartedBody(3));
    assert.throws(() => harness.writer.prepare('dispatch_started', dispatchStartedBody(4)), {
      name: 'Error',
      message: 'prepare(dispatch_started) with 1 pending append(s) and reservation none; expected an idle writer',
    });
    const appended = await pending;
    assert.equal(appendedEvent(appended).source_sequence, 2);
    assert.equal(prepared(harness, 5).event.source_sequence, 3);
  });

  it('the prepared event carries the scope identity', () => {
    const put = prepared(writerHarness());
    assert.equal(put.event.trial_id, TRIAL_SCOPE.partition.kind === 'trial' ? TRIAL_SCOPE.partition.trial_id : '');
  });
});
