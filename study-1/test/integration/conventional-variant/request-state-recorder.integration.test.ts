// RequestStateRecorder over the DynamoDB emulator (BR-RUA-004, BR-RUA-022, BR-RUA-033): each
// recording is one transaction of the `request_state_recorded` put and the request-state item,
// conditioned on the version it replaces, so versions stay dense and an event exists exactly
// when the state changed. Knowledge transitions follow the BR-RUA-022 table; a refused write is
// resubmitted identically within the budget and every other refusal is reported, never
// re-planned.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toRequestStateItem } from '../../../src/conventional-variant/request-state/request-state-item.ts';
import { RequestStateRecorder } from '../../../src/conventional-variant/request-state/request-state-recorder.ts';
import type { RequestStateRecordResult } from '../../../src/conventional-variant/request-state/request-state-recorder.ts';
import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { InterleavingItemStore } from '../../support/cleanup/interleaving-item-store.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { TRIAL_SCOPE } from '../../support/event-journal/journal-fixtures.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { EPOCH_MS, REFUND_REQUEST_ID, TRIAL_PK } from '../../unit/trial-message/support/trial-message-fixtures.ts';

const REQUEST = { refund_request_id: REFUND_REQUEST_ID };
const ATTEMPT_A = 'dddddddd-0000-4000-8000-00000000000a' as Uuid4;
const ATTEMPT_B = 'dddddddd-0000-4000-8000-00000000000b' as Uuid4;
const CAUSE = '11111111-0000-4000-8000-000000000001' as Uuid4;
const STATE_SK = `state#request#${REFUND_REQUEST_ID}`;
const validator = createRecordValidator();

interface RecorderBench {
  readonly store: InMemoryItemStore;
  readonly journal: JournalWriter;
  readonly recorder: RequestStateRecorder;
}

function bench(maxDefinitiveRetries = 2): RecorderBench {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const store = new InMemoryItemStore({ clock: time });
  const ids = new SequentialUuidSource('eeeeeeee');
  const journal = new JournalWriter({
    port: createDurableJournalPort(store, 'caller_journal'),
    source: 'conventional_caller',
    instanceId: ids.next(),
    scope: TRIAL_SCOPE,
    clock: time,
    ids,
    maxDefinitiveRetries,
  });
  return {
    store,
    journal,
    recorder: new RequestStateRecorder({ store, journal, scope: TRIAL_SCOPE, maxDefinitiveRetries }),
  };
}

function attemptItem(attemptId: Uuid4, phase: string): StoredItem {
  return {
    pk: TRIAL_PK,
    sk: `state#attempt#${attemptId}`,
    attempt_id: attemptId,
    provider_request_id: 'ffffffff-0000-4000-8000-000000000001',
    refund_request_id: REFUND_REQUEST_ID,
    phase,
  };
}

function stateItem(store: InMemoryItemStore, sk: string = STATE_SK): StoredItem | undefined {
  return store.peek('caller_journal', { pk: TRIAL_PK, sk });
}

function failureOf(result: RequestStateRecordResult): readonly [string, string] {
  assert.equal(result.kind, 'not_recorded', JSON.stringify(result));
  return [result.code, result.detail];
}

function recordedEvent(result: RequestStateRecordResult): Readonly<Record<string, JsonValue>> {
  assert.equal(result.kind, 'recorded', JSON.stringify(result));
  const event = result.event as unknown as JsonValue;
  assert.ok(validator.validate(event).valid, JSON.stringify(event));
  return event as Readonly<Record<string, JsonValue>>;
}

describe('RequestStateRecorder writes', () => {
  it('records version 1 then 2, folding knowledge and appending the attempt ids', async () => {
    const { store, recorder } = bench();
    const first = recordedEvent(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
        { processing_state: 'RUNNING' },
        [CAUSE],
      ),
    );
    assert.deepEqual(
      [
        first['version'],
        first['processing_state'],
        first['effect_knowledge'],
        first['attempt_ids'],
        first['causation_event_ids'],
      ],
      [1, 'RUNNING', 'UNKNOWN', [ATTEMPT_A], [CAUSE]],
    );
    const second = recordedEvent(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_B, outcome_class: 'SUCCESS' },
        { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' },
        [CAUSE],
      ),
    );
    assert.deepEqual(
      [second['version'], second['processing_terminal_reason'], second['effect_knowledge'], second['attempt_ids']],
      [2, 'SUCCEEDED', 'UNKNOWN', [ATTEMPT_A, ATTEMPT_B]],
    );
    assert.deepEqual(
      { ...stateItem(store), pk: undefined, sk: undefined },
      {
        pk: undefined,
        sk: undefined,
        version: 2,
        effect_knowledge: 'UNKNOWN',
        attempt_ids: [ATTEMPT_A, ATTEMPT_B],
        processing_state: 'FINISHED',
      },
    );
  });

  it('resubmits a definitively refused transaction identically and records it on the retry', async () => {
    const { store, recorder } = bench();
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'InternalServerError' }, { operation: 'transact' });
    const event = recordedEvent(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'SUCCESS' },
        { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' },
        [CAUSE],
      ),
    );
    assert.equal(event['source_sequence'], 1, 'the retry keeps the identity and sequence of the refused put');
    assert.equal(stateItem(store)?.['effect_knowledge'], 'ONE_EFFECT_CONFIRMED');
  });

  it('reports REJECTED once the retry budget is spent, naming the tries and the last code', async () => {
    const { store, recorder } = bench(1);
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'InternalServerError' }, { operation: 'transact' });
    store.scriptWriteFault({ kind: 'definitive_failure', code: 'ValidationException' }, { operation: 'transact' });
    const [code, detail] = failureOf(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
        { processing_state: 'RUNNING' },
        [CAUSE],
      ),
    );
    assert.deepEqual(
      [code, detail],
      ['REJECTED', `${STATE_SK} v1: 2 identical transaction(s) refused definitively; last "ValidationException"`],
    );
    assert.equal(stateItem(store), undefined);
  });

  it('reports JOURNAL_STOPPED for an ambiguous transaction, and for every recording after it', async () => {
    const { store, recorder, journal } = bench();
    store.scriptWriteFault({ kind: 'ambiguous', code: 'TimeoutError', applied: true }, { operation: 'transact' });
    const [code, detail] = failureOf(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
        { processing_state: 'RUNNING' },
        [CAUSE],
      ),
    );
    assert.equal(code, 'JOURNAL_STOPPED');
    assert.match(detail, /^request_state_recorded v1 not written: /u);
    assert.equal(journal.isStopped(), true);
    const [laterCode, laterDetail] = failureOf(
      await recorder.recordMessageRejected(undefined, { message_id: 'm-1', causation_event_ids: [CAUSE] }),
    );
    assert.equal(laterCode, 'JOURNAL_STOPPED');
    assert.match(laterDetail, /stopped earlier by/u);
  });

  it('reports VERSION_CONFLICT when the stored version moved since it was read', async () => {
    const { store, recorder, journal } = bench();
    recordedEvent(await recorder.recordMessageRejected(REQUEST, { message_id: 'm-1', causation_event_ids: [CAUSE] }));
    // Another writer replaces version 1 right after this recorder read it.
    const racing = new InterleavingItemStore(store);
    racing.afterRead(1, async (inner) => {
      const moved = { version: 2, effect_knowledge: 'UNKNOWN', attempt_ids: [], processing_state: 'RUNNING' } as const;
      await inner.write({
        kind: 'put',
        table: 'caller_journal',
        item: toRequestStateItem({ pk: TRIAL_PK, sk: STATE_SK }, moved),
      });
    });
    const stale = new RequestStateRecorder({ store: racing, journal, scope: TRIAL_SCOPE, maxDefinitiveRetries: 2 });
    const [code, detail] = failureOf(
      await stale.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
        { processing_state: 'RUNNING' },
        [CAUSE],
      ),
    );
    assert.deepEqual(
      [code, detail],
      [
        'VERSION_CONFLICT',
        `${STATE_SK} changed since version 1 was read; expected it unchanged until version 2 is written`,
      ],
    );
    assert.equal(stateItem(store)?.['effect_knowledge'], 'UNKNOWN');
  });
});

describe('RequestStateRecorder reads', () => {
  it('reports STATE_UNREADABLE when the state read fails, naming the code', async () => {
    const { store, recorder } = bench();
    store.scriptReadFault('ProvisionedThroughputExceededException', { operation: 'getConsistent' });
    const [code, detail] = failureOf(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
        { processing_state: 'RUNNING' },
        [CAUSE],
      ),
    );
    assert.deepEqual(
      [code, detail],
      ['STATE_UNREADABLE', `request-state read of ${STATE_SK} failed: "ProvisionedThroughputExceededException"`],
    );
  });

  it('reports STATE_UNREADABLE on reconciliation when the state read or the partition query fails', async () => {
    const { store, recorder } = bench();
    store.scriptReadFault('InternalServerError', { operation: 'getConsistent' });
    assert.equal(failureOf(await recorder.reconcileOrphans(REQUEST, [CAUSE]))[0], 'STATE_UNREADABLE');
    store.scriptReadFault('InternalServerError', { operation: 'queryPartitionPage' });
    assert.deepEqual(failureOf(await recorder.reconcileOrphans(REQUEST, [CAUSE])), [
      'STATE_UNREADABLE',
      `partition query of ${TRIAL_PK} failed: "InternalServerError"`,
    ]);
  });

  it('reports STATE_UNREADABLE when an attempt-state item of the partition is damaged', async () => {
    const { store, recorder } = bench();
    store.seed('caller_journal', attemptItem(ATTEMPT_A, 'LOST'));
    const [code, detail] = failureOf(await recorder.reconcileOrphans(REQUEST, [CAUSE]));
    assert.equal(code, 'STATE_UNREADABLE');
    assert.match(detail, /phase string "LOST"; expected/u);
  });

  it('leaves the state unchanged when every attempt is accounted for', async () => {
    const { store, recorder } = bench();
    store.seed('caller_journal', attemptItem(ATTEMPT_A, 'DISPATCHED'));
    recordedEvent(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'AMBIGUOUS' },
        { processing_state: 'RUNNING' },
        [CAUSE],
      ),
    );
    assert.deepEqual(await recorder.reconcileOrphans(REQUEST, [CAUSE]), { kind: 'unchanged' });
  });

  it('finds an orphan on a later page and folds it after the attempts already recorded', async () => {
    const { store, recorder } = bench();
    store.setPageSize(1);
    store.seed('caller_journal', attemptItem(ATTEMPT_A, 'DISPATCHED'));
    store.seed('caller_journal', attemptItem(ATTEMPT_B, 'NOT_DISPATCHED'));
    recordedEvent(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'SUCCESS' },
        { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' },
        [CAUSE],
      ),
    );
    const event = recordedEvent(await recorder.reconcileOrphans(REQUEST, [CAUSE]));
    assert.deepEqual(
      [event['version'], event['processing_state'], event['effect_knowledge'], event['attempt_ids']],
      [2, 'RUNNING', 'ONE_EFFECT_CONFIRMED', [ATTEMPT_A, ATTEMPT_B]],
    );
  });

  it('records a rejection over an existing state with its knowledge unchanged', async () => {
    const { store, recorder } = bench();
    recordedEvent(
      await recorder.recordAttemptResult(
        REQUEST,
        { attempt_id: ATTEMPT_A, outcome_class: 'SUCCESS' },
        { processing_state: 'FINISHED', terminal_reason: 'SUCCEEDED' },
        [CAUSE],
      ),
    );
    const event = recordedEvent(
      await recorder.recordMessageRejected(REQUEST, { message_id: 'm-2', causation_event_ids: [CAUSE] }),
    );
    assert.deepEqual(
      [event['version'], event['processing_terminal_reason'], event['effect_knowledge'], event['attempt_ids']],
      [2, 'MESSAGE_REJECTED', 'ONE_EFFECT_CONFIRMED', [ATTEMPT_A]],
    );
    const unkeyed = recordedEvent(
      await recorder.recordMessageRejected(undefined, { message_id: 'm-3', causation_event_ids: [CAUSE] }),
    );
    assert.equal('refund_request_id' in unkeyed, false);
    assert.equal(stateItem(store, 'state#rejected-message#m-3')?.['version'], 1);
  });
});
