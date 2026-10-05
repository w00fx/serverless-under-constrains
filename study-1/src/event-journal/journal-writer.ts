// BR-RUA-033 append semantics for one source instance:
// - `source_sequence` is dense and strictly increasing from 1 within (source, instance);
// - appends are serialized: one event at a time, in call order;
// - a definitive failed append is retried with identical identity, content and sequence;
// - after an ambiguous append result the instance stops emitting events for good, and a
//   restart creates a new source instance (a new writer with a new instance id).
//
// Events written inside a caller-owned transaction (for example `dispatch_started` with the
// `PRE_DISPATCH -> DISPATCHED` transition, design §5.3 C3) use `prepare` and `confirm`. A
// transaction that was definitively not applied leaves no event, so its sequence is reused by
// the next event and the persisted sequence stays dense.

import type { WriteOutcome } from '../durable-store/item-store-port.ts';
import type { EventSource } from '../record-contract/envelope.ts';
import type { Uuid4, UuidSource, WallClock } from '../record-contract/primitives.ts';
import type { EventRecordType } from '../record-contract/record-types.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type {
  AppendResult,
  ConfirmResult,
  JournalAppendPort,
  JournalOutcomeClass,
  JournalStopped,
  JournalStopReason,
  PrepareResult,
} from './journal-append-port.ts';
import { classifyJournalOutcome } from './journal-append-port.ts';
import type { JournalEntry } from './journal-entry.ts';
import { toJournalEntry } from './journal-entry.ts';
import type { EventBody } from './journal-event.ts';
import { buildJournalEvent } from './journal-event.ts';
import type { JournalScope } from './journal-scope.ts';
import { journalItemKey } from './journal-scope.ts';

export interface JournalWriterDeps {
  readonly port: JournalAppendPort;
  readonly source: EventSource;
  readonly instanceId: Uuid4;
  readonly scope: JournalScope;
  readonly clock: WallClock;
  readonly ids: UuidSource;
  /** Identical retries after a definitive failure, beyond the first attempt (0 = no retry). */
  readonly maxDefinitiveRetries: number;
}

/** A put reserved by `prepare` for a caller-owned transaction; `confirm` settles it. */
export type PreparedJournalPut = JournalEntry;

/**
 * The writer of one source instance.
 *
 * @example
 * const journal = new JournalWriter({ port: createDurableJournalPort(store, 'caller_journal'),
 *   source: 'conventional_caller', instanceId: uuids.next(), scope, clock, ids: uuids, maxDefinitiveRetries: 2 });
 * const result = await journal.append('caller_invocation_started', body);
 * if (result.kind === 'stopped') return; // the instance can emit nothing more
 */
export class JournalWriter {
  readonly #deps: JournalWriterDeps;
  #nextSequence = 1;
  #stopReason: JournalStopReason | undefined;
  #reservation: PreparedJournalPut | undefined;
  #appendsInFlight = 0;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(deps: JournalWriterDeps) {
    if (!Number.isSafeInteger(deps.maxDefinitiveRetries) || deps.maxDefinitiveRetries < 0) {
      throw new RangeError(
        `maxDefinitiveRetries ${String(deps.maxDefinitiveRetries)}; expected a nonnegative safe integer`,
      );
    }
    this.#deps = deps;
  }

  /**
   * Appends one event after every earlier append of this writer has settled.
   *
   * @example
   * await journal.append('treatment_timeout_observed', body, [signalEventId]);
   */
  append<T extends EventRecordType>(
    type: T,
    body: EventBody<T>,
    causation: readonly Uuid4[] = [],
  ): Promise<AppendResult> {
    this.#appendsInFlight += 1;
    const result = this.#tail.then(() => this.#appendInOrder(type, body, causation));
    this.#tail = result.catch(() => undefined);
    return result.finally(() => {
      this.#appendsInFlight -= 1;
    });
  }

  /**
   * Reserves the next sequence for an event that a caller-owned transaction will write (put it
   * in the transaction with `journalPutAction`), then settle it with `confirm`. Throws an Error
   * while another put is reserved or an append is pending, because appends are serialized.
   *
   * @example
   * const prepared = journal.prepare('dispatch_started', body);
   * if (prepared.kind === 'prepared') journal.confirm(prepared.put, await attempts.transitionToDispatched(id, prepared.put));
   */
  prepare<T extends EventRecordType>(type: T, body: EventBody<T>, causation: readonly Uuid4[] = []): PrepareResult {
    if (this.#stopReason !== undefined) {
      return stopped('INSTANCE_ALREADY_STOPPED');
    }
    this.#assertIdle(`prepare(${type})`);
    const put = this.#nextEntry(type, body, causation);
    this.#reservation = put;
    return { kind: 'prepared', put };
  }

  /**
   * Settles the reserved put with the outcome of the transaction that carried it: `applied`
   * advances the sequence, an ambiguous outcome or a sequence conflict stops the instance, and
   * a transaction that was definitively not applied frees the sequence. Throws an Error when
   * `prepared` is not the outstanding reservation.
   *
   * @example
   * const confirmed = journal.confirm(prepared.put, outcome); // { kind: 'appended', event }
   */
  confirm(prepared: PreparedJournalPut, outcome: WriteOutcome): ConfirmResult {
    if (prepared !== this.#reservation) {
      throw new Error(
        `confirm() for ${prepared.key.sk} without its reservation (outstanding: ${this.#reservation?.key.sk ?? 'none'}); expected the put returned by the last prepare()`,
      );
    }
    this.#reservation = undefined;
    const verdict = classifyJournalOutcome(outcome, prepared);
    if (verdict === 'not_applied') {
      return { kind: 'not_applied', event: prepared.event, outcome };
    }
    return this.#settle(verdict, prepared);
  }

  /** Whether the instance has stopped emitting events. */
  isStopped(): boolean {
    return this.#stopReason !== undefined;
  }

  async #appendInOrder<T extends EventRecordType>(
    type: T,
    body: EventBody<T>,
    causation: readonly Uuid4[],
  ): Promise<AppendResult> {
    if (this.#stopReason !== undefined) {
      return stopped('INSTANCE_ALREADY_STOPPED');
    }
    if (this.#reservation !== undefined) {
      throw new Error(
        `append(${type}) while the put ${this.#reservation.key.sk} is reserved; expected confirm() before the next append`,
      );
    }
    const entry = this.#nextEntry(type, body, causation);
    for (let attempt = 0; attempt <= this.#deps.maxDefinitiveRetries; attempt += 1) {
      const verdict = await this.#write(entry);
      if (verdict !== 'not_applied') {
        return this.#settle(verdict, entry);
      }
    }
    return this.#stop('DEFINITIVE_RETRIES_EXHAUSTED');
  }

  async #write(entry: JournalEntry): Promise<JournalOutcomeClass> {
    try {
      return classifyJournalOutcome(await this.#deps.port.append(entry), entry);
    } catch {
      // A port that throws gives no proof either way, so the write counts as ambiguous.
      return 'ambiguous';
    }
  }

  #settle(verdict: 'applied' | 'ambiguous' | 'sequence_conflict', entry: JournalEntry): AppendResult {
    if (verdict === 'ambiguous') {
      return this.#stop('AMBIGUOUS_APPEND');
    }
    if (verdict === 'sequence_conflict') {
      return this.#stop('SEQUENCE_CONFLICT');
    }
    this.#nextSequence += 1;
    return { kind: 'appended', event: entry.event };
  }

  #stop(reason: JournalStopReason): JournalStopped {
    this.#stopReason = reason;
    return stopped(reason);
  }

  #assertIdle(operation: string): void {
    if (this.#reservation !== undefined || this.#appendsInFlight > 0) {
      throw new Error(
        `${operation} with ${String(this.#appendsInFlight)} pending append(s) and reservation ${this.#reservation?.key.sk ?? 'none'}; expected an idle writer`,
      );
    }
  }

  #nextEntry<T extends EventRecordType>(type: T, body: EventBody<T>, causation: readonly Uuid4[]): JournalEntry {
    const { scope, source, instanceId, clock, ids } = this.#deps;
    const sequence = this.#nextSequence;
    const event = buildJournalEvent(type, body, {
      scope,
      source,
      source_instance_id: instanceId,
      source_sequence: sequence,
      event_id: ids.next(),
      occurred_at: formatUtcMillis(clock.now()),
      causation,
    });
    return toJournalEntry(journalItemKey(scope, source, instanceId, sequence), event);
  }
}

function stopped(reason: JournalStopReason): JournalStopped {
  return { kind: 'stopped', reason };
}
