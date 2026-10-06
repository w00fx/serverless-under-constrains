// The lease store port (design §5.3 `coordination-lease/`): one conditional write per lease
// transition and one strongly consistent read of the lease item. Production binds it to the
// baseline coordination table through `createDurableLeaseStore`; offline tests bind the same
// adapter to the in-memory coordination-store emulation (`FakeLeaseStore`).
//
// Writes resolve to the store's closed outcome union and never throw: a condition failure
// carries the item as it was (ALL_OLD), so the caller learns who holds the lease without a
// second read ([R-aws] §1.2).

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import { executionIdOf } from '../event-journal/journal-scope.ts';
import type { ExecutionIdentity, Result, Sha256Hex, UtcMillis } from '../record-contract/primitives.ts';
import type { LeaseItem, LeaseOwner } from './lease-item.ts';

/** Why the lease item could not be read: the store failed, or the item does not decode. */
export interface LeaseReadFailure {
  readonly code: string;
  readonly detail: string;
}

export interface LeaseStorePort {
  /** Puts a fresh held item (version 1) when no item exists or the lease was explicitly released. */
  acquire(owner: LeaseOwner, at: UtcMillis): Promise<WriteOutcome>;
  /** Raises the version and the heartbeat while this owner holds the lease at `expectedVersion`. */
  heartbeat(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome>;
  /** Sets `RELEASED` while this owner holds the lease (held or recovery required) at `expectedVersion`. */
  release(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome>;
  /** Sets `RECOVERY_REQUIRED` while this owner holds the lease at `expectedVersion`. */
  markRecoveryRequired(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome>;
  /** Strongly consistent read; `undefined` when no lease item exists. */
  read(): Promise<Result<LeaseItem | undefined, LeaseReadFailure>>;
}

/**
 * The lease owner of an execution: its kind, its execution id and its frozen manifest digest
 * (BR-RUA-045 "owner kind, owner identity, owner-manifest digest").
 *
 * @example
 * leaseOwnerOf({ execution_kind: 'RUN', run_id }, manifestSha); // { owner_kind: 'RUN', owner_id: run_id, owner_manifest_sha256: manifestSha }
 */
export function leaseOwnerOf(execution: ExecutionIdentity, manifestSha256: Sha256Hex): LeaseOwner {
  return {
    owner_kind: execution.execution_kind,
    owner_id: executionIdOf(execution),
    owner_manifest_sha256: manifestSha256,
  };
}
