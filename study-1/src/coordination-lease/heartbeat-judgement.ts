// What one conditional heartbeat established about ownership (BR-RUA-045, design §10.3):
// - applied: confirmed, at the next version;
// - definitively rejected: not confirmed, not refuted (uncertainty);
// - ambiguous: resolved by a consistent read. The write landed when the item shows this owner,
//   held, at the next version with this heartbeat's instant ([R-aws] §1.2 "already applied");
// - condition failed: the item as it was (ALL_OLD, or a consistent read when the store could
//   not return it) decides. This owner, still held, means an earlier write of this owner landed
//   unseen: the version is adopted and the beat counts as unconfirmed. Any other owner or
//   status, an absent item (a deleted item, for example by TTL, never proves release) or an
//   item that does not decode refutes ownership: a mismatch.
// A read that fails refutes nothing, so it leaves the beat unconfirmed.

import type { StoredItem, WriteOutcome } from '../durable-store/item-store-port.ts';
import type { MonotonicClock, Result, UtcMillis } from '../record-contract/primitives.ts';
import type { LeaseObservation } from './lease-health.ts';
import type { LeaseItem, LeaseOwner } from './lease-item.ts';
import { LEASE_REASON_CODES, decodeLeaseItem, describeHolder, isOwnedBy } from './lease-item.ts';
import type { LeaseReadFailure, LeaseStorePort } from './lease-store-port.ts';

export interface HeartbeatAttempt {
  readonly owner: LeaseOwner;
  readonly expected_version: number;
  readonly issued_ns: bigint;
  readonly at: UtcMillis;
}

export interface HeartbeatJudgement {
  readonly observation: LeaseObservation;
  /** The item the judgement read, when it read one. */
  readonly observed?: LeaseItem;
  readonly detail: string;
}

interface JudgementDeps {
  readonly store: LeaseStorePort;
  readonly monotonic: MonotonicClock;
}

/**
 * Judges the outcome of one conditional heartbeat.
 *
 * @example
 * const judged = await judgeHeartbeat(await store.heartbeat(owner, 3, at), { owner, expected_version: 3, issued_ns, at }, deps);
 * judged.observation.kind; // 'confirmed' | 'failed' | 'mismatch'
 */
export async function judgeHeartbeat(
  outcome: WriteOutcome,
  attempt: HeartbeatAttempt,
  deps: JudgementDeps,
): Promise<HeartbeatJudgement> {
  switch (outcome.kind) {
    case 'applied':
      return confirmed(attempt, deps, 'conditional heartbeat applied');
    case 'definitive_failure':
      return failed(deps, `heartbeat rejected with ${outcome.code}`);
    case 'ambiguous':
      return judgeAmbiguous(outcome.code, attempt, deps);
    case 'condition_failed':
      return judgeConditionFailure(outcome.existing, attempt, deps);
  }
}

async function judgeAmbiguous(
  code: string,
  attempt: HeartbeatAttempt,
  deps: JudgementDeps,
): Promise<HeartbeatJudgement> {
  const read = await deps.store.read();
  if (read.ok && read.value !== undefined && heartbeatLanded(read.value, attempt)) {
    return confirmed(attempt, deps, `ambiguous heartbeat (${code}) confirmed by a consistent read`);
  }
  return judgeRead(read, attempt, deps, `ambiguous heartbeat (${code})`);
}

async function judgeConditionFailure(
  existing: StoredItem | undefined,
  attempt: HeartbeatAttempt,
  deps: JudgementDeps,
): Promise<HeartbeatJudgement> {
  if (existing === undefined) {
    return judgeRead(await deps.store.read(), attempt, deps, 'heartbeat condition failed without the item');
  }
  const decoded = decodeLeaseItem(existing);
  if (!decoded.ok) {
    return mismatch(deps, LEASE_REASON_CODES.itemUndecodable, `heartbeat condition failed: ${decoded.error.detail}`);
  }
  return judgeItem(decoded.value, attempt, deps, 'heartbeat condition failed');
}

function judgeRead(
  read: Result<LeaseItem | undefined, LeaseReadFailure>,
  attempt: HeartbeatAttempt,
  deps: JudgementDeps,
  context: string,
): HeartbeatJudgement {
  if (!read.ok) {
    return read.error.code === LEASE_REASON_CODES.itemUndecodable
      ? mismatch(deps, read.error.code, `${context}: ${read.error.detail}`)
      : failed(deps, `${context}; ownership unresolved: ${read.error.detail}`);
  }
  if (read.value === undefined) {
    return mismatch(
      deps,
      LEASE_REASON_CODES.itemAbsent,
      `${context}: the lease item is absent; an absent item never proves release`,
    );
  }
  return judgeItem(read.value, attempt, deps, context);
}

function judgeItem(
  item: LeaseItem,
  attempt: HeartbeatAttempt,
  deps: JudgementDeps,
  context: string,
): HeartbeatJudgement {
  if (isOwnedBy(item, attempt.owner) && item.lease_status === 'HELD') {
    return {
      observation: { kind: 'failed', observed_ns: deps.monotonic.nowNs(), adopted_version: item.lease_version },
      observed: item,
      detail: `${context}; the item still names this owner, held at version ${String(item.lease_version)} (expected ${String(attempt.expected_version)})`,
    };
  }
  return {
    ...mismatch(deps, LEASE_REASON_CODES.ownershipMismatch, `${context}; the item shows ${describeHolder(item)}`),
    observed: item,
  };
}

function heartbeatLanded(item: LeaseItem, attempt: HeartbeatAttempt): boolean {
  return (
    isOwnedBy(item, attempt.owner) &&
    item.lease_status === 'HELD' &&
    item.lease_version === attempt.expected_version + 1 &&
    item.heartbeat_at === attempt.at
  );
}

function confirmed(attempt: HeartbeatAttempt, deps: JudgementDeps, detail: string): HeartbeatJudgement {
  return {
    observation: {
      kind: 'confirmed',
      issued_ns: attempt.issued_ns,
      observed_ns: deps.monotonic.nowNs(),
      at: attempt.at,
      lease_version: attempt.expected_version + 1,
    },
    detail,
  };
}

function failed(deps: JudgementDeps, detail: string): HeartbeatJudgement {
  return { observation: { kind: 'failed', observed_ns: deps.monotonic.nowNs() }, detail };
}

function mismatch(deps: JudgementDeps, code: string, detail: string): HeartbeatJudgement {
  return { observation: { kind: 'mismatch', observed_ns: deps.monotonic.nowNs(), code }, detail };
}
