// createDurableAttemptStatePort (design §9.3, BR-RUA-021): every operation is one transaction of
// the journal put and the state write, with the event id as token; registration requires an
// absent state item and each transition requires PRE_DISPATCH, so a phase changes at most once.
// The store is InMemoryItemStore, whose transaction semantics the durable-store conformance
// suite pins against DynamoDB.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import type { PreparedJournalPut } from '../../../src/event-journal/journal-writer.ts';
import type { AttemptRegistration } from '../../../src/provider-client/attempt-state-port.ts';
import {
  ATTEMPT_JOURNAL_ACTION_INDEX,
  ATTEMPT_PHASES,
  attemptStateSortKey,
} from '../../../src/provider-client/attempt-state-port.ts';
import {
  ATTEMPT_STATE_TABLE,
  createDurableAttemptStatePort,
} from '../../../src/provider-client/durable-attempt-state-port.ts';
import {
  ATTEMPT_ID,
  dispatchStartedBody,
  PROVIDER_REQUEST_ID,
  writerHarness,
} from '../../support/event-journal/journal-fixtures.ts';
import type { WriterHarness } from '../../support/event-journal/journal-fixtures.ts';

const REGISTRATION: AttemptRegistration = {
  attempt_id: ATTEMPT_ID,
  provider_request_id: PROVIDER_REQUEST_ID,
  refund_request_id: 'ref-poc-001',
};

async function settled(
  harness: WriterHarness,
  write: (put: PreparedJournalPut) => Promise<WriteOutcome>,
): Promise<WriteOutcome> {
  const prepared = harness.writer.prepare('dispatch_started', dispatchStartedBody());
  assert.ok(prepared.kind === 'prepared');
  const outcome = await write(prepared.put);
  harness.writer.confirm(prepared.put, outcome, ATTEMPT_JOURNAL_ACTION_INDEX);
  return outcome;
}

function stateItem(harness: WriterHarness): Readonly<Record<string, unknown>> | undefined {
  const pk = harness.store.itemsIn(ATTEMPT_STATE_TABLE).find((item) => item.sk.startsWith('state#'))?.pk ?? '';
  return harness.store.peek(ATTEMPT_STATE_TABLE, { pk, sk: attemptStateSortKey(ATTEMPT_ID) });
}

describe('attempt state keys', () => {
  it('lists the three phases and keys each attempt under state#attempt#', () => {
    assert.deepEqual(ATTEMPT_PHASES, ['PRE_DISPATCH', 'NOT_DISPATCHED', 'DISPATCHED']);
    assert.equal(attemptStateSortKey(ATTEMPT_ID), `state#attempt#${ATTEMPT_ID}`);
    assert.equal(ATTEMPT_STATE_TABLE, 'caller_journal');
  });
});

describe('createDurableAttemptStatePort', () => {
  it('registers PRE_DISPATCH next to the event in one transaction tokened by the event id', async () => {
    const harness = writerHarness();
    const port = createDurableAttemptStatePort(harness.store);
    let put: PreparedJournalPut | undefined;
    const outcome = await settled(harness, (prepared) => {
      put = prepared;
      return port.registerPreDispatch(REGISTRATION, prepared);
    });
    assert.deepEqual(outcome, { kind: 'applied' });
    assert.ok(put !== undefined);
    assert.deepEqual(harness.store.peek(ATTEMPT_STATE_TABLE, put.key), put.item);
    assert.deepEqual(harness.store.peek(ATTEMPT_STATE_TABLE, { pk: put.key.pk, sk: attemptStateSortKey(ATTEMPT_ID) }), {
      pk: put.key.pk,
      sk: attemptStateSortKey(ATTEMPT_ID),
      attempt_id: ATTEMPT_ID,
      provider_request_id: PROVIDER_REQUEST_ID,
      refund_request_id: 'ref-poc-001',
      phase: 'PRE_DISPATCH',
    });
    const transactions = harness.log.entries().filter((entry) => entry.operation === 'TransactWriteItems');
    assert.deepEqual(
      transactions.map(({ target, detail }) => ({ target, detail })),
      [{ target: 'caller_journal', detail: { client_request_token: put.event.event_id, action_count: 2 } }],
    );
  });

  it('refuses a second registration of the same attempt', async () => {
    const harness = writerHarness();
    const port = createDurableAttemptStatePort(harness.store);
    await settled(harness, (put) => port.registerPreDispatch(REGISTRATION, put));
    const again = await settled(harness, (put) => port.registerPreDispatch(REGISTRATION, put));
    assert.equal(again.kind, 'condition_failed');
    assert.equal(again.failed_action_index, 1);
    assert.equal(stateItem(harness)?.['phase'], 'PRE_DISPATCH');
  });

  for (const [operation, phase] of [
    ['transitionToDispatched', 'DISPATCHED'],
    ['transitionToNotDispatched', 'NOT_DISPATCHED'],
  ] as const) {
    it(`${operation} moves PRE_DISPATCH to ${phase} once, with its event`, async () => {
      const harness = writerHarness();
      const port = createDurableAttemptStatePort(harness.store);
      await settled(harness, (put) => port.registerPreDispatch(REGISTRATION, put));
      const moved = await settled(harness, (put) => port[operation](ATTEMPT_ID, put));
      assert.deepEqual(moved, { kind: 'applied' });
      assert.equal(stateItem(harness)?.['phase'], phase);
      assert.equal(stateItem(harness)?.['refund_request_id'], 'ref-poc-001');

      const eventsBefore = harness.store.itemsIn(ATTEMPT_STATE_TABLE).length;
      const twice = await settled(harness, (put) => port.transitionToDispatched(ATTEMPT_ID, put));
      assert.equal(twice.kind, 'condition_failed');
      const once = await settled(harness, (put) => port.transitionToNotDispatched(ATTEMPT_ID, put));
      assert.equal(once.kind, 'condition_failed');
      assert.equal(stateItem(harness)?.['phase'], phase);
      assert.equal(harness.store.itemsIn(ATTEMPT_STATE_TABLE).length, eventsBefore);
    });
  }

  it('refuses a transition of an attempt that was never registered', async () => {
    const harness = writerHarness();
    const port = createDurableAttemptStatePort(harness.store);
    const outcome = await settled(harness, (put) => port.transitionToDispatched(ATTEMPT_ID, put));
    assert.equal(outcome.kind, 'condition_failed');
    assert.deepEqual(harness.store.itemsIn(ATTEMPT_STATE_TABLE), []);
  });
});
