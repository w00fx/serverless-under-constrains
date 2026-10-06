// Conformance of FakeLeaseStore, the coordination-store emulation (design §12.2), to the lease
// store port and to the DynamoDB semantics it stands for:
// - a conditional write that fails takes no effect and returns the item as it was (ALL_OLD);
//   an ambiguous outcome may or may not have taken effect; a consistent read sees every
//   applied write ([R-aws] §1.2, https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_PutItem.html
//   `ReturnValuesOnConditionCheckFailure`);
// - the baseline table has no TTL attribute, so passing time never removes an expired item;
//   a TTL deletion, when one happens, removes the item asynchronously and without any write of
//   the owner ([R-aws] TTL, https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html).
// Scripted faults, answers and holds are consumed in order and counted until consumed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { acquiredLeaseItem } from '../../../../src/coordination-lease/lease-item.ts';
import type { UtcMillis } from '../../../../src/record-contract/primitives.ts';
import { FakeLeaseStore } from '../../../support/coordination-lease/fake-lease-store.ts';
import {
  EPOCH_MS,
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  storedLeaseItem,
} from '../../../support/coordination-lease/lease-fixtures.ts';
import { RecordingMutationLog } from '../../../support/kernel/recording-mutation-log.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';

const PAST = '2026-10-05T11:00:00.000Z' as UtcMillis;

function emulation(): {
  readonly time: VirtualTimeScheduler;
  readonly store: FakeLeaseStore;
  readonly log: RecordingMutationLog;
} {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const log = new RecordingMutationLog();
  return { time, store: new FakeLeaseStore({ clock: time, mutationLog: log }), log };
}

describe('FakeLeaseStore conformance: conditional writes', () => {
  it('applies a conditional put once and returns the item as it was on the second', async () => {
    const { store, log } = emulation();
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await store.acquire(FOREIGN_OWNER, EPOCH_UTC), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: storedLeaseItem(RUN_OWNER, EPOCH_UTC),
    });
    assert.deepEqual(store.current(), storedLeaseItem(RUN_OWNER, EPOCH_UTC));
    assert.deepEqual(await store.read(), { ok: true, value: acquiredLeaseItem(RUN_OWNER, EPOCH_UTC) });
    assert.deepEqual(
      log.entries().map((entry) => [entry.operation, entry.target]),
      [
        ['PutItem', 'coordination'],
        ['PutItem', 'coordination'],
      ],
    );
  });

  it('takes no effect on a definitive failure', async () => {
    const { store } = emulation();
    store.failNextWrites(1, { kind: 'definitive_failure', code: 'AccessDeniedException' });
    assert.equal(store.pendingScriptCount(), 1);
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), {
      kind: 'definitive_failure',
      code: 'AccessDeniedException',
    });
    assert.equal(store.current(), undefined);
    assert.equal(store.pendingScriptCount(), 0);
  });

  it('may or may not take effect on an ambiguous outcome', async () => {
    const { store } = emulation();
    store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: false });
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'ambiguous', code: 'TimeoutError' });
    assert.equal(store.current(), undefined);
    store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'ambiguous', code: 'TimeoutError' });
    assert.deepEqual(store.current(), storedLeaseItem(RUN_OWNER, EPOCH_UTC));
  });

  it('applies heartbeat, recovery and release through the same conditions', async () => {
    const { store } = emulation();
    await store.acquire(RUN_OWNER, EPOCH_UTC);
    assert.deepEqual(await store.heartbeat(RUN_OWNER, 1, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await store.markRecoveryRequired(RUN_OWNER, 2, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(await store.release(RUN_OWNER, 3, EPOCH_UTC), { kind: 'applied' });
    assert.equal((await store.release(RUN_OWNER, 4, EPOCH_UTC)).kind, 'condition_failed');
    assert.deepEqual(
      store.current(),
      storedLeaseItem(RUN_OWNER, EPOCH_UTC, { lease_status: 'RELEASED', lease_version: 4 }),
    );
  });

  it('fails the scripted number of writes, one per write, in order', async () => {
    const { store } = emulation();
    await store.acquire(RUN_OWNER, EPOCH_UTC);
    store.failNextWrites(2, { kind: 'definitive_failure', code: 'ThrottlingException' });
    assert.equal(store.pendingScriptCount(), 2);
    assert.equal((await store.heartbeat(RUN_OWNER, 1, EPOCH_UTC)).kind, 'definitive_failure');
    assert.equal((await store.heartbeat(RUN_OWNER, 1, EPOCH_UTC)).kind, 'definitive_failure');
    assert.equal((await store.heartbeat(RUN_OWNER, 1, EPOCH_UTC)).kind, 'applied');
  });
});

describe('FakeLeaseStore conformance: reads', () => {
  it('fails the scripted number of consistent reads, then reads again', async () => {
    const { store } = emulation();
    store.seed(storedLeaseItem(RUN_OWNER, EPOCH_UTC));
    store.failNextReads(2, 'InternalServerError');
    const failure = {
      ok: false,
      error: { code: 'LEASE_READ_FAILED', detail: 'consistent read failed with InternalServerError' },
    };
    assert.deepEqual(await store.read(), failure);
    assert.deepEqual(await store.read(), failure);
    assert.deepEqual(await store.read(), { ok: true, value: acquiredLeaseItem(RUN_OWNER, EPOCH_UTC) });
  });
});

describe('FakeLeaseStore conformance: scripted answers and holds', () => {
  it('answers the next write without touching the table', async () => {
    const { store, log } = emulation();
    store.answerNextWrite({ kind: 'condition_failed', failed_action_index: 0 });
    assert.equal(store.pendingScriptCount(), 1);
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'condition_failed', failed_action_index: 0 });
    assert.equal(store.current(), undefined);
    assert.equal(log.isEmpty(), true);
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'applied' });
  });

  it('holds the next write until released', async () => {
    const { time, store } = emulation();
    assert.equal(store.isWriteHeld(), false);
    store.holdNextWrite();
    assert.equal(store.pendingScriptCount(), 1);
    const write = store.acquire(RUN_OWNER, EPOCH_UTC);
    await time.advanceBy(60_000);
    assert.equal(store.isWriteHeld(), true);
    assert.equal(store.pendingScriptCount(), 0);
    assert.equal(store.current(), undefined);
    store.releaseHeldWrite();
    assert.equal(store.isWriteHeld(), false);
    assert.deepEqual(await write, { kind: 'applied' });
    assert.deepEqual(await store.heartbeat(RUN_OWNER, 1, EPOCH_UTC), { kind: 'applied' });
  });

  it('refuses to release when no write waits', () => {
    const { store } = emulation();
    store.holdNextWrite();
    assert.throws(() => {
      store.releaseHeldWrite();
    }, /^Error: releaseHeldWrite\(\) with no write waiting; expected holdNextWrite\(\) and a lease write in flight$/);
  });
});

describe('FakeLeaseStore conformance: no TTL, and TTL deletion', () => {
  it('never removes an expired item as time passes (the table has no TTL)', async () => {
    const { time, store } = emulation();
    const expired = storedLeaseItem(FOREIGN_OWNER, PAST, { expires_at: PAST });
    store.seed(expired);
    await time.advanceBy(86_400_000);
    assert.deepEqual(store.current(), expired);
    assert.equal((await store.acquire(RUN_OWNER, EPOCH_UTC)).kind, 'condition_failed');
  });

  it('takes over the lease for another owner at a chosen version', () => {
    const { store, log } = emulation();
    store.takeOverBy(FOREIGN_OWNER, EPOCH_UTC, 6);
    assert.deepEqual(store.current(), storedLeaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 6 }));
    assert.equal(log.isEmpty(), true, 'a takeover is not a write of this owner');
  });

  it('deletes only the lease item, as a TTL deletion would, and drops pending faults', async () => {
    const { store } = emulation();
    await store.acquire(RUN_OWNER, EPOCH_UTC);
    const other = { pk: 'other', sk: 'x', note: 'kept' };
    store.seed(other);
    store.failNextWrites(1, { kind: 'definitive_failure', code: 'ThrottlingException' });
    store.failNextReads(1, 'InternalServerError');
    store.deleteLeaseItemAsTtl();
    assert.equal(store.current(), undefined);
    assert.deepEqual(store.current({ pk: 'other', sk: 'x' }), other);
    assert.equal(store.pendingScriptCount(), 0);
    assert.deepEqual(await store.read(), { ok: true, value: undefined });
    assert.equal((await store.heartbeat(RUN_OWNER, 1, EPOCH_UTC)).kind, 'condition_failed');
    assert.deepEqual(await store.acquire(RUN_OWNER, EPOCH_UTC), { kind: 'applied' });
    assert.deepEqual(store.current({ pk: 'other', sk: 'x' }), other);
  });
});
