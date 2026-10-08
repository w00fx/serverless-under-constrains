// What one conditional heartbeat established (BR-RUA-045; design §10.3; [R-aws] §1.2): applied
// confirms at the next version; a definitive failure is uncertainty; an ambiguous outcome is
// settled by a consistent read; a failed condition is judged on the item as it was. The same
// owner still held means an unseen earlier write landed (version adopted, unconfirmed); any
// other owner or status, an absent item or an undecodable one is a mismatch; a failed read
// refutes nothing.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { HeartbeatAttempt } from '../../../src/coordination-lease/heartbeat-judgement.ts';
import { judgeHeartbeat } from '../../../src/coordination-lease/heartbeat-judgement.ts';
import type { LeaseItem } from '../../../src/coordination-lease/lease-item.ts';
import { LEASE_ITEM_KEY, describeHolder } from '../../../src/coordination-lease/lease-item.ts';
import type { UtcMillis } from '../../../src/record-contract/primitives.ts';
import { FakeLeaseStore } from '../../support/coordination-lease/fake-lease-store.ts';
import {
  EPOCH_MS,
  EPOCH_UTC,
  FOREIGN_OWNER,
  RUN_OWNER,
  leaseItem,
  storedLeaseItem,
} from '../../support/coordination-lease/lease-fixtures.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const AT = '2026-10-05T12:00:30.000Z' as UtcMillis;
const ISSUED_NS = 30_000_000_000n;

interface Judge {
  readonly time: VirtualTimeScheduler;
  readonly store: FakeLeaseStore;
  readonly attempt: HeartbeatAttempt;
}

function judge(seed?: LeaseItem): Judge {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS, monotonicOriginNs: ISSUED_NS });
  const store = new FakeLeaseStore({ clock: time });
  if (seed !== undefined) {
    store.seed({ ...seed });
  }
  return { time, store, attempt: { owner: RUN_OWNER, expected_version: 3, issued_ns: ISSUED_NS, at: AT } };
}

function judged(subject: Judge, outcome: Parameters<typeof judgeHeartbeat>[0]): ReturnType<typeof judgeHeartbeat> {
  return judgeHeartbeat(outcome, subject.attempt, { store: subject.store, monotonic: subject.time });
}

const heldAt = (version: number, changes: Partial<LeaseItem> = {}): LeaseItem =>
  leaseItem(RUN_OWNER, EPOCH_UTC, { lease_version: version, ...changes });

describe('judgeHeartbeat on applied and definitive outcomes', () => {
  it('confirms an applied heartbeat at the next version', async () => {
    const subject = judge();
    assert.deepEqual(await judged(subject, { kind: 'applied' }), {
      observation: { kind: 'confirmed', issued_ns: ISSUED_NS, observed_ns: ISSUED_NS, at: AT, lease_version: 4 },
      detail: 'conditional heartbeat applied',
    });
  });

  it('treats a definitive rejection as unconfirmed, not refuted', async () => {
    assert.deepEqual(await judged(judge(), { kind: 'definitive_failure', code: 'ThrottlingException' }), {
      observation: { kind: 'failed', observed_ns: ISSUED_NS },
      detail: 'heartbeat rejected with ThrottlingException',
    });
  });
});

describe('judgeHeartbeat on an ambiguous outcome', () => {
  it('confirms when the consistent read shows this heartbeat landed', async () => {
    const subject = judge(heldAt(4, { heartbeat_at: AT }));
    const result = await judged(subject, { kind: 'ambiguous', code: 'TimeoutError' });
    assert.equal(result.observation.kind, 'confirmed');
    assert.equal(result.detail, 'ambiguous heartbeat (TimeoutError) confirmed by a consistent read');
  });

  it('does not confirm when the version, instant, status or owner differ', async () => {
    const notLanded: readonly LeaseItem[] = [
      heldAt(3),
      heldAt(5, { heartbeat_at: AT }),
      heldAt(4),
      heldAt(4, { heartbeat_at: AT, lease_status: 'RELEASED' }),
      leaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 4, heartbeat_at: AT }),
    ];
    for (const item of notLanded) {
      const result = await judged(judge(item), { kind: 'ambiguous', code: 'TimeoutError' });
      assert.notEqual(result.observation.kind, 'confirmed', `confirmed on ${describeHolder(item)}`);
    }
  });

  it('adopts the version when this owner still holds the item at another version', async () => {
    const result = await judged(judge(heldAt(3)), { kind: 'ambiguous', code: 'TimeoutError' });
    assert.deepEqual(result, {
      observation: { kind: 'failed', observed_ns: ISSUED_NS, adopted_version: 3 },
      observed: heldAt(3),
      detail: 'ambiguous heartbeat (TimeoutError); the item still names this owner, held at version 3 (expected 3)',
    });
  });

  it('stays unconfirmed when the resolving read fails', async () => {
    const subject = judge(heldAt(4, { heartbeat_at: AT }));
    subject.store.failNextReads(1, 'InternalServerError');
    assert.deepEqual(await judged(subject, { kind: 'ambiguous', code: 'TimeoutError' }), {
      observation: { kind: 'failed', observed_ns: ISSUED_NS },
      detail:
        'ambiguous heartbeat (TimeoutError); ownership unresolved: consistent read failed with InternalServerError',
    });
  });

  it('is a mismatch when the item is absent: absence never proves release', async () => {
    assert.deepEqual(await judged(judge(), { kind: 'ambiguous', code: 'TimeoutError' }), {
      observation: { kind: 'mismatch', observed_ns: ISSUED_NS, code: 'LEASE_ITEM_ABSENT' },
      detail: 'ambiguous heartbeat (TimeoutError): the lease item is absent; an absent item never proves release',
    });
  });

  it('is a mismatch when the item does not decode', async () => {
    const subject = judge();
    subject.store.seed(storedLeaseItem(RUN_OWNER, EPOCH_UTC, { lease_status: 'LOST' as never }));
    const result = await judged(subject, { kind: 'ambiguous', code: 'TimeoutError' });
    assert.deepEqual(result.observation, { kind: 'mismatch', observed_ns: ISSUED_NS, code: 'LEASE_ITEM_UNDECODABLE' });
    assert.match(
      result.detail,
      /^ambiguous heartbeat \(TimeoutError\): lease item member lease_status is string "LOST"/,
    );
  });
});

describe('judgeHeartbeat on a failed condition', () => {
  it('adopts the version when the item as it was still names this owner, held', async () => {
    const subject = judge();
    const result = await judged(subject, {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { ...heldAt(5) },
    });
    assert.deepEqual(result.observation, { kind: 'failed', observed_ns: ISSUED_NS, adopted_version: 5 });
    assert.equal(
      result.detail,
      'heartbeat condition failed; the item still names this owner, held at version 5 (expected 3)',
    );
  });

  it('is an ownership mismatch for another owner, naming the holder', async () => {
    const foreign = leaseItem(FOREIGN_OWNER, EPOCH_UTC, { lease_version: 8 });
    const result = await judged(judge(), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { ...foreign },
    });
    assert.deepEqual(result, {
      observation: { kind: 'mismatch', observed_ns: ISSUED_NS, code: 'LEASE_OWNERSHIP_MISMATCH' },
      observed: foreign,
      detail: `heartbeat condition failed; the item shows ${describeHolder(foreign)}`,
    });
  });

  it('is an ownership mismatch for this owner once released or recovery required', async () => {
    for (const lease_status of ['RELEASED', 'RECOVERY_REQUIRED'] as const) {
      const existing = { ...heldAt(3, { lease_status }) };
      const result = await judged(judge(), { kind: 'condition_failed', failed_action_index: 0, existing });
      assert.equal(result.observation.kind, 'mismatch');
    }
  });

  it('is a mismatch when the item as it was does not decode', async () => {
    const result = await judged(judge(), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { ...LEASE_ITEM_KEY },
    });
    assert.deepEqual(result.observation, { kind: 'mismatch', observed_ns: ISSUED_NS, code: 'LEASE_ITEM_UNDECODABLE' });
    assert.match(result.detail, /^heartbeat condition failed: lease item member coordination_schema_version is absent/);
  });

  it('reads the item when the store could not return it', async () => {
    const foreign = leaseItem(FOREIGN_OWNER, EPOCH_UTC);
    const result = await judged(judge(foreign), { kind: 'condition_failed', failed_action_index: 0 });
    assert.equal(result.observation.kind, 'mismatch');
    assert.deepEqual(result.observed, foreign);
    assert.match(result.detail, /^heartbeat condition failed without the item; the item shows TRANSPORT_PROBE/);
  });

  it('is a mismatch when the item it reads is absent', async () => {
    const result = await judged(judge(), { kind: 'condition_failed', failed_action_index: 0 });
    assert.deepEqual(result.observation, { kind: 'mismatch', observed_ns: ISSUED_NS, code: 'LEASE_ITEM_ABSENT' });
  });
});

describe('judgeHeartbeat timing', () => {
  it('stamps the observation when the judgement completes', async () => {
    const subject = judge();
    await subject.time.advanceBy(2_000);
    const result = await judged(subject, { kind: 'definitive_failure', code: 'X' });
    assert.equal(result.observation.observed_ns, ISSUED_NS + 2_000_000_000n);
  });
});
