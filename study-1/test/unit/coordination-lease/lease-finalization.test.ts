// Lease finalization (BR-RUA-045; design §10.2 P8, §10.3): a clean closure releases, an unclean
// one marks recovery; the pre-read sets the version and detects a lease that is no longer this
// owner's (state unverified, or nothing held after an unresolved acquisition); ambiguous writes
// are settled by a read; failed writes are RELEASE_FAILED (clean) or STATE_UNVERIFIED (unclean).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { LeaseItem } from '../../../src/coordination-lease/lease-item.ts';
import { LEASE_ITEM_KEY, describeHolder } from '../../../src/coordination-lease/lease-item.ts';
import type { FinalizationRequest, LeaseClosure } from '../../../src/coordination-lease/lease-finalization.ts';
import { finalizeLease } from '../../../src/coordination-lease/lease-finalization.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import {
  EPOCH_MS,
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  leaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const NOW = '2026-10-05T12:30:00.000Z' as UtcMillis;

function storeWith(item?: LeaseItem): FakeLeaseStore {
  const store = new FakeLeaseStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
  if (item !== undefined) {
    store.seed({ ...item });
  }
  return store;
}

function request(
  store: FakeLeaseStore,
  closure: LeaseClosure,
  changes: Partial<FinalizationRequest> = {},
): FinalizationRequest {
  return { store, owner: RUN_OWNER, closure, known_version: 3, held: true, now: () => NOW, ...changes };
}

const ownedAt = (version: number, changes: Partial<LeaseItem> = {}): LeaseItem =>
  leaseItem(RUN_OWNER, EPOCH_UTC, { lease_version: version, ...changes });

describe('finalizeLease on an item this owner holds', () => {
  it('releases on a clean closure at the version the item shows', async () => {
    const store = storeWith(ownedAt(5));
    assert.deepEqual(await finalizeLease(request(store, 'clean')), {
      lease_event: 'RELEASED',
      lease_version: 6,
      detail: `the item shows ${describeHolder(ownedAt(5))}; conditional RELEASED write at version 5 applied`,
    });
    assert.deepEqual(store.current(), { ...ownedAt(6), lease_status: 'RELEASED', updated_at: NOW });
  });

  it('marks recovery required on an unclean closure', async () => {
    const store = storeWith(ownedAt(5));
    const verdict = await finalizeLease(request(store, 'unclean'));
    assert.equal(verdict.lease_event, 'RECOVERY_REQUIRED');
    assert.equal(verdict.lease_version, 6);
    assert.equal(store.current()?.['lease_status'], 'RECOVERY_REQUIRED');
  });

  it('reports an already released item without writing', async () => {
    for (const closure of ['clean', 'unclean'] as const) {
      const item = ownedAt(7, { lease_status: 'RELEASED' });
      const store = storeWith(item);
      store.failNextWrites(1, { kind: 'definitive_failure', code: 'MustNotWrite' });
      assert.deepEqual(await finalizeLease(request(store, closure)), {
        lease_event: 'RELEASED',
        lease_version: 7,
        observed: item,
        detail: 'already released',
      });
      assert.equal(store.pendingScriptCount(), 1);
    }
  });

  it('keeps recovery required on an unclean closure without writing', async () => {
    const item = ownedAt(7, { lease_status: 'RECOVERY_REQUIRED' });
    const store = storeWith(item);
    assert.deepEqual(await finalizeLease(request(store, 'unclean')), {
      lease_event: 'RECOVERY_REQUIRED',
      lease_version: 7,
      observed: item,
      detail: 'already marked recovery required',
    });
    assert.deepEqual(store.current(), { ...item });
  });

  it('releases a recovery-required item on a clean closure', async () => {
    const store = storeWith(ownedAt(7, { lease_status: 'RECOVERY_REQUIRED' }));
    const verdict = await finalizeLease(request(store, 'clean'));
    assert.equal(verdict.lease_event, 'RELEASED');
    assert.equal(verdict.lease_version, 8);
  });
});

describe('finalizeLease on an item this owner does not hold', () => {
  it('is unverified for a held session when the item is absent (absence never proves release)', async () => {
    assert.deepEqual(await finalizeLease(request(storeWith(), 'clean')), {
      lease_event: 'STATE_UNVERIFIED',
      detail: 'the lease item is absent; release cannot be established (TTL expiry or absence never proves release)',
    });
  });

  it('is unverified for a held session when another owner holds the item', async () => {
    const foreign = leaseItem(FOREIGN_OWNER, EPOCH_UTC);
    const verdict = await finalizeLease(request(storeWith(foreign), 'unclean'));
    assert.equal(verdict.lease_event, 'STATE_UNVERIFIED');
    assert.deepEqual(verdict.observed, foreign);
    assert.match(verdict.detail, /^the item shows TRANSPORT_PROBE/);
  });

  it('holds nothing after an unresolved acquisition that never landed', async () => {
    assert.deepEqual(await finalizeLease(request(storeWith(), 'clean', { held: false })), {
      lease_event: 'RELEASED',
      detail: 'the unresolved acquisition never landed (the lease item is absent); this owner holds nothing',
    });
    const foreign = leaseItem(FOREIGN_OWNER, EPOCH_UTC);
    const verdict = await finalizeLease(request(storeWith(foreign), 'unclean', { held: false }));
    assert.equal(verdict.lease_event, 'RELEASED');
    assert.deepEqual(verdict.observed, foreign);
  });

  it('releases an unresolved acquisition that did land', async () => {
    const store = storeWith(ownedAt(1));
    const verdict = await finalizeLease(request(store, 'clean', { held: false, known_version: 1 }));
    assert.equal(verdict.lease_event, 'RELEASED');
    assert.equal(store.current()?.['lease_status'], 'RELEASED');
  });
});

describe('finalizeLease when the pre-read fails', () => {
  it('writes at the version the session knows', async () => {
    const store = storeWith(ownedAt(3));
    store.failNextReads(1, 'InternalServerError');
    assert.deepEqual(await finalizeLease(request(store, 'clean')), {
      lease_event: 'RELEASED',
      lease_version: 4,
      detail:
        'the pre-finalization read failed: consistent read failed with InternalServerError; conditional RELEASED write at version 3 applied',
    });
  });

  it('fails the release when the known version is stale, naming the item as it was', async () => {
    const store = storeWith(ownedAt(4));
    store.failNextReads(1, 'InternalServerError');
    const verdict = await finalizeLease(request(store, 'clean'));
    assert.equal(verdict.lease_event, 'RELEASE_FAILED');
    assert.deepEqual(verdict.observed, ownedAt(4));
    assert.match(
      verdict.detail,
      /conditional RELEASED write at version 3 failed: the ownership condition did not hold$/,
    );
  });

  it('is unverified when an unclean write fails its condition', async () => {
    const store = storeWith(ownedAt(4));
    store.failNextReads(1, 'InternalServerError');
    const verdict = await finalizeLease(request(store, 'unclean'));
    assert.equal(verdict.lease_event, 'STATE_UNVERIFIED');
    assert.match(verdict.detail, /conditional RECOVERY_REQUIRED write at version 3 failed/);
  });
});

describe('finalizeLease write failures', () => {
  it('names a definitive failure of the release: RELEASE_FAILED', async () => {
    const store = storeWith(ownedAt(3));
    store.failNextWrites(1, { kind: 'definitive_failure', code: 'AccessDeniedException' });
    const verdict = await finalizeLease(request(store, 'clean'));
    assert.deepEqual(verdict, {
      lease_event: 'RELEASE_FAILED',
      detail: `the item shows ${describeHolder(ownedAt(3))}; conditional RELEASED write at version 3 failed: AccessDeniedException`,
    });
  });

  it('is unverified when a recovery write fails definitively', async () => {
    const store = storeWith(ownedAt(3));
    store.failNextWrites(1, { kind: 'definitive_failure', code: 'AccessDeniedException' });
    assert.equal((await finalizeLease(request(store, 'unclean'))).lease_event, 'STATE_UNVERIFIED');
  });

  it('omits the item when a failed condition carries none or an undecodable one', async () => {
    for (const existing of [undefined, { ...LEASE_ITEM_KEY }]) {
      const store = storeWith(ownedAt(3));
      store.answerNextWrite(
        existing === undefined
          ? { kind: 'condition_failed', failed_action_index: 0 }
          : { kind: 'condition_failed', failed_action_index: 0, existing },
      );
      const verdict = await finalizeLease(request(store, 'clean'));
      assert.equal(verdict.lease_event, 'RELEASE_FAILED');
      assert.equal(Object.hasOwn(verdict, 'observed'), false);
    }
  });
});

describe('finalizeLease on an ambiguous write', () => {
  it('confirms a release that landed', async () => {
    const store = storeWith(ownedAt(3));
    store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    const verdict = await finalizeLease(request(store, 'clean'));
    assert.equal(verdict.lease_event, 'RELEASED');
    assert.equal(verdict.lease_version, 4);
    assert.match(verdict.detail, /was ambiguous \(TimeoutError\); a consistent read confirms it$/);
  });

  it('confirms a recovery mark that landed', async () => {
    const store = storeWith(ownedAt(3));
    store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    assert.equal((await finalizeLease(request(store, 'unclean'))).lease_event, 'RECOVERY_REQUIRED');
  });

  it('is unverified when the write did not land', async () => {
    const store = storeWith(ownedAt(3));
    store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: false });
    const verdict = await finalizeLease(request(store, 'clean'));
    assert.equal(verdict.lease_event, 'STATE_UNVERIFIED');
    assert.deepEqual(verdict.observed, ownedAt(3));
    assert.match(verdict.detail, /was ambiguous \(TimeoutError\); the item shows RUN .* HELD at version 3/);
  });

  it('is unverified when the item another owner holds or no item follows the ambiguity', async () => {
    const foreign = storeWith(ownedAt(3));
    foreign.answerNextWrite({ kind: 'ambiguous', code: 'TimeoutError' });
    foreign.takeOverBy(FOREIGN_OWNER, EPOCH_UTC, 4);
    const takenOver = await finalizeLease(request(foreign, 'clean', { known_version: 3 }));
    assert.equal(takenOver.lease_event, 'STATE_UNVERIFIED');

    const absent = storeWith();
    absent.failNextReads(1, 'InternalServerError');
    absent.answerNextWrite({ kind: 'ambiguous', code: 'TimeoutError' });
    const verdict = await finalizeLease(request(absent, 'clean'));
    assert.deepEqual(verdict, {
      lease_event: 'STATE_UNVERIFIED',
      detail:
        'the pre-finalization read failed: consistent read failed with InternalServerError; conditional RELEASED write at version 3 was ambiguous (TimeoutError); the lease item is absent',
    });
  });

  it('is unverified for an item this owner holds under the other status', async () => {
    const store = storeWith(ownedAt(3, { lease_status: 'RECOVERY_REQUIRED' }));
    store.answerNextWrite({ kind: 'ambiguous', code: 'TimeoutError' });
    assert.equal((await finalizeLease(request(store, 'clean'))).lease_event, 'STATE_UNVERIFIED');
  });

  it('is unverified when the resolving read fails', async () => {
    const store = storeWith(ownedAt(3));
    store.failNextReads(2, 'InternalServerError');
    store.failNextWrites(1, { kind: 'ambiguous', code: 'TimeoutError', applied: true });
    assert.deepEqual(await finalizeLease(request(store, 'clean')), {
      lease_event: 'STATE_UNVERIFIED',
      detail:
        'the pre-finalization read failed: consistent read failed with InternalServerError; conditional RELEASED write at version 3 was ambiguous (TimeoutError); the resolving read failed: consistent read failed with InternalServerError',
    });
    assert.equal(store.current()?.['lease_status'], 'RELEASED');
  });
});
