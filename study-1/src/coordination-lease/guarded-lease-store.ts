// The lease store as the session uses it: one that never throws (BR-RUA-045; WP-22 review).
// The port contract already returns closed outcome unions, but an adapter defect can still
// throw or reject. A thrown write gives no proof either way, so it counts as an ambiguous
// write, exactly as the journal writer counts a throwing append port
// (`event-journal/journal-writer.ts`); a thrown read is a failed read. Every lease decision
// then follows its documented ambiguous path: a heartbeat that throws is an unconfirmed beat
// (uncertainty blocks new publication at once, and a store that keeps throwing ends in
// staleness at the 300 s boundary, which the heartbeat loop hands to the runner). Without this
// guard such a beat rejected, and the loop, which ends quietly on a rejected beat, stopped
// heartbeating with ownership still shown as confirmed and no loss ever reported.

import { errorCode } from '../durable-store/dynamo-error-classification.ts';
import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { Result } from '../record-contract/primitives.ts';
import type { LeaseItem } from './lease-item.ts';
import { LEASE_REASON_CODES } from './lease-item.ts';
import type { LeaseReadFailure, LeaseStorePort } from './lease-store-port.ts';

/** The ambiguous-outcome code of a write whose store call threw, before the error's name. */
export const LEASE_STORE_THREW = 'LeaseStoreThrew';

/**
 * Wraps a lease store so that no call throws or rejects: a throwing write resolves as
 * `{ kind: 'ambiguous', code: 'LeaseStoreThrew:<error name>' }`, a throwing read as a
 * `LEASE_READ_FAILED` failure. Outcomes the store returns pass through unchanged.
 *
 * @example
 * const store = guardLeaseStore(createDurableLeaseStore(itemStore));
 * await store.heartbeat(owner, 3, at); // { kind: 'ambiguous', code: 'LeaseStoreThrew:TypeError' } if the adapter threw
 */
export function guardLeaseStore(store: LeaseStorePort): LeaseStorePort {
  return {
    acquire: (owner, at) => guardedWrite(() => store.acquire(owner, at)),
    heartbeat: (owner, expectedVersion, at) => guardedWrite(() => store.heartbeat(owner, expectedVersion, at)),
    release: (owner, expectedVersion, at) => guardedWrite(() => store.release(owner, expectedVersion, at)),
    markRecoveryRequired: (owner, expectedVersion, at) =>
      guardedWrite(() => store.markRecoveryRequired(owner, expectedVersion, at)),
    read: () => guardedRead(() => store.read()),
  };
}

// `await` inside `try` catches a synchronous throw of the call as well as a rejection.
async function guardedWrite(write: () => Promise<WriteOutcome>): Promise<WriteOutcome> {
  try {
    return await write();
  } catch (error: unknown) {
    return { kind: 'ambiguous', code: `${LEASE_STORE_THREW}:${thrownName(error)}` };
  }
}

async function guardedRead(
  read: () => Promise<Result<LeaseItem | undefined, LeaseReadFailure>>,
): Promise<Result<LeaseItem | undefined, LeaseReadFailure>> {
  try {
    return await read();
  } catch (error: unknown) {
    return {
      ok: false,
      error: { code: LEASE_REASON_CODES.readFailed, detail: `the consistent read threw ${thrownName(error)}` },
    };
  }
}

// The thrown value's name, cut to the kernel bound: an error name is free text.
function thrownName(error: unknown): string {
  return boundedText(errorCode(error));
}
