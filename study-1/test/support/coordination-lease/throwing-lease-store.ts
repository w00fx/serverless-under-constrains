// A lease store decorator that breaks the port contract on purpose: scripted calls throw
// (synchronously, as a non-async adapter method would) or reject (as an async one would)
// instead of returning a closed outcome. It stands for an adapter defect, which the session's
// store guard must turn into an ambiguous write or a failed read (WP-22 review). Calls with no
// scripted fault pass to the wrapped store unchanged.

import type { WriteOutcome } from '../../../src/durable-store/item-store-port.ts';
import type { LeaseItem, LeaseOwner } from '../../../src/coordination-lease/lease-item.ts';
import type { LeaseReadFailure, LeaseStorePort } from '../../../src/coordination-lease/lease-store-port.ts';
import type { Result, UtcMillis } from '../../../src/record-contract/primitives.ts';

/** How a scripted call breaks: a synchronous throw or a rejected promise of `error`. */
export interface ThrownFault {
  readonly mode: 'throw' | 'reject';
  readonly error: unknown;
}

/**
 * Wraps a lease store; the next scripted writes or reads throw or reject.
 *
 * @example
 * const store = new ThrowingLeaseStore(new FakeLeaseStore({ clock: time }));
 * store.throwOnNextWrites(1, { mode: 'reject', error: new TypeError('defect') });
 * await store.heartbeat(owner, 1, at); // rejects with the TypeError
 */
export class ThrowingLeaseStore implements LeaseStorePort {
  readonly #inner: LeaseStorePort;
  readonly #writeFaults: ThrownFault[] = [];
  readonly #readFaults: ThrownFault[] = [];

  constructor(inner: LeaseStorePort) {
    this.#inner = inner;
  }

  /** The next `count` writes (acquire, heartbeat, release, recovery) break with `fault`. */
  throwOnNextWrites(count: number, fault: ThrownFault): void {
    for (let index = 0; index < count; index += 1) {
      this.#writeFaults.push(fault);
    }
  }

  /** The next `count` reads break with `fault`. */
  throwOnNextReads(count: number, fault: ThrownFault): void {
    for (let index = 0; index < count; index += 1) {
      this.#readFaults.push(fault);
    }
  }

  /** Scripted faults not consumed yet. */
  pendingFaultCount(): number {
    return this.#writeFaults.length + this.#readFaults.length;
  }

  acquire(owner: LeaseOwner, at: UtcMillis): Promise<WriteOutcome> {
    return breakOrPass(this.#writeFaults.shift(), () => this.#inner.acquire(owner, at));
  }

  heartbeat(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome> {
    return breakOrPass(this.#writeFaults.shift(), () => this.#inner.heartbeat(owner, expectedVersion, at));
  }

  release(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome> {
    return breakOrPass(this.#writeFaults.shift(), () => this.#inner.release(owner, expectedVersion, at));
  }

  markRecoveryRequired(owner: LeaseOwner, expectedVersion: number, at: UtcMillis): Promise<WriteOutcome> {
    return breakOrPass(this.#writeFaults.shift(), () => this.#inner.markRecoveryRequired(owner, expectedVersion, at));
  }

  read(): Promise<Result<LeaseItem | undefined, LeaseReadFailure>> {
    return breakOrPass(this.#readFaults.shift(), () => this.#inner.read());
  }
}

function breakOrPass<T>(fault: ThrownFault | undefined, pass: () => Promise<T>): Promise<T> {
  if (fault === undefined) {
    return pass();
  }
  if (fault.mode === 'throw') {
    throw fault.error;
  }
  return rejectWith(fault.error);
}

// An async function that throws: the call returns normally and its promise rejects with the
// value as thrown, a non-Error value included.
async function rejectWith(error: unknown): Promise<never> {
  await Promise.resolve();
  throw error;
}
