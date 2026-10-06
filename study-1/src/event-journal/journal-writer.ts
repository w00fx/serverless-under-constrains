// BR-RUA-033 append semantics for one source instance:
// - `source_sequence` is dense and strictly increasing from 1 within (source, instance);
// - appends are serialized: one event at a time, in call order;
// - a definitive failed append is retried with identical identity, content and sequence;
// - after an ambiguous append result the instance stops emitting events for good, and a
//   restart creates a new source instance (a new writer with a new instance id).
//
// Events written inside a caller-owned transaction (for example `dispatch_started` with the
// `PRE_DISPATCH -> DISPATCHED` transition, design §5.3 C3) use `prepare` and `confirm`. A
// transaction that was definitively not applied leaves no event. The caller then either
// resubmits the identical put (`prepareRetry`, BR-RUA-033 identical retry) or re-plans
// (D-23): the next `prepare` or `append` reuses the sequence, so the persisted sequence stays
// dense.

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

// A standalone append is one conditional put, so a failed condition is always its own (index 0).
const STANDALONE_PUT_INDEX = 0;

interface WriteVerdict {
  readonly verdict: JournalOutcomeClass;
  /** The outcome or the thrown error, for the stop detail. */
  readonly observed: string;
}

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
  #stopped: JournalStopped | undefined;
  #reservation: PreparedJournalPut | undefined;
  #retryable: PreparedJournalPut | undefined;
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
   * if (prepared.kind === 'prepared') journal.confirm(prepared.put, await attempts.transitionToDispatched(id, prepared.put), 0);
   */
  prepare<T extends EventRecordType>(type: T, body: EventBody<T>, causation: readonly Uuid4[] = []): PrepareResult {
    if (this.#stopped !== undefined) {
      return this.#alreadyStopped(this.#stopped);
    }
    this.#assertIdle(`prepare(${type})`);
    return this.#reserve(this.#nextEntry(type, body, causation));
  }

  /**
   * Reserves again a put whose transaction was definitively not applied, so the caller can
   * resubmit it unchanged: identical event identity, content and sequence (BR-RUA-033). Only
   * the last not-applied put qualifies, and only until another event is prepared or appended
   * (a caller that re-plans, D-23, simply prepares its new event, which reuses the sequence).
   * Throws an Error for any other put, or while the writer is not idle.
   *
   * @example
   * const confirmed = journal.confirm(prepared.put, outcome, 1); // { kind: 'not_applied', … }
   * const again = journal.prepareRetry(prepared.put); // { kind: 'prepared', put: prepared.put }
   */
  prepareRetry(put: PreparedJournalPut): PrepareResult {
    if (this.#stopped !== undefined) {
      return this.#alreadyStopped(this.#stopped);
    }
    this.#assertIdle(`prepareRetry(${put.key.sk})`);
    if (put !== this.#retryable) {
      throw new Error(
        `prepareRetry() for ${put.key.sk} (retryable: ${this.#retryable?.key.sk ?? 'none'}); expected the last put that confirm() reported not_applied, before any other event`,
      );
    }
    return this.#reserve(put);
  }

  /**
   * Settles the reserved put with the outcome of the transaction that carried it: `applied`
   * advances the sequence, an ambiguous outcome or a sequence conflict stops the instance, and
   * a transaction that was definitively not applied frees the sequence (or `prepareRetry`
   * resubmits the same put). `journalActionIndex` is the put's index in the transaction, so a
   * failed condition on the put itself is never mistaken for a failed business condition.
   * Throws an Error when `prepared` is not the outstanding reservation.
   *
   * @example
   * const confirmed = journal.confirm(prepared.put, outcome, 1); // { kind: 'appended', event }
   */
  confirm(prepared: PreparedJournalPut, outcome: WriteOutcome, journalActionIndex: number): ConfirmResult {
    if (prepared !== this.#reservation) {
      throw new Error(
        `confirm() for ${prepared.key.sk} without its reservation (outstanding: ${this.#reservation?.key.sk ?? 'none'}); expected the put returned by the last prepare()`,
      );
    }
    this.#reservation = undefined;
    const verdict = classifyJournalOutcome(outcome, prepared, journalActionIndex);
    if (verdict === 'not_applied') {
      this.#retryable = prepared;
      return { kind: 'not_applied', event: prepared.event, outcome };
    }
    return this.#settle({ verdict, observed: describeOutcome(outcome) }, prepared);
  }

  /**
   * Whether the instance has stopped emitting events; a restart needs a new writer with a new
   * instance id.
   *
   * @example
   * if (journal.isStopped()) journal = new JournalWriter({ ...deps, instanceId: uuids.next() });
   */
  isStopped(): boolean {
    return this.#stopped !== undefined;
  }

  async #appendInOrder<T extends EventRecordType>(
    type: T,
    body: EventBody<T>,
    causation: readonly Uuid4[],
  ): Promise<AppendResult> {
    if (this.#stopped !== undefined) {
      return this.#alreadyStopped(this.#stopped);
    }
    if (this.#reservation !== undefined) {
      throw new Error(
        `append(${type}) while the put ${this.#reservation.key.sk} is reserved; expected confirm() before the next append`,
      );
    }
    const entry = this.#nextEntry(type, body, causation);
    let last = await this.#write(entry);
    for (let retry = 0; last.verdict === 'not_applied' && retry < this.#deps.maxDefinitiveRetries; retry += 1) {
      last = await this.#write(entry);
    }
    if (last.verdict !== 'not_applied') {
      return this.#settle(last, entry);
    }
    return this.#stop(
      'DEFINITIVE_RETRIES_EXHAUSTED',
      `${entry.key.sk}: ${String(this.#deps.maxDefinitiveRetries + 1)} identical attempt(s) failed definitively; last outcome ${last.observed}`,
    );
  }

  async #write(entry: JournalEntry): Promise<WriteVerdict> {
    try {
      const outcome = await this.#deps.port.append(entry);
      return {
        verdict: classifyJournalOutcome(outcome, entry, STANDALONE_PUT_INDEX),
        observed: describeOutcome(outcome),
      };
    } catch (error: unknown) {
      // A port that throws gives no proof either way, so the write counts as ambiguous.
      return { verdict: 'ambiguous', observed: `port threw ${describeError(error)}` };
    }
  }

  #settle(result: WriteVerdict, entry: JournalEntry): AppendResult {
    if (result.verdict === 'ambiguous') {
      return this.#stop('AMBIGUOUS_APPEND', `${entry.key.sk}: ${result.observed}; the event may or may not be stored`);
    }
    if (result.verdict === 'sequence_conflict') {
      return this.#stop(
        'SEQUENCE_CONFLICT',
        `${entry.key.sk}: ${result.observed}; other content occupies this sequence`,
      );
    }
    this.#nextSequence += 1;
    return { kind: 'appended', event: entry.event };
  }

  #stop(reason: JournalStopReason, detail: string): JournalStopped {
    this.#stopped = { kind: 'stopped', reason, detail };
    return this.#stopped;
  }

  #alreadyStopped(first: JournalStopped): JournalStopped {
    return {
      kind: 'stopped',
      reason: 'INSTANCE_ALREADY_STOPPED',
      detail: `stopped earlier by ${first.reason}: ${first.detail}`,
    };
  }

  #reserve(put: PreparedJournalPut): PrepareResult {
    this.#reservation = put;
    this.#retryable = undefined;
    return { kind: 'prepared', put };
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
    this.#retryable = undefined;
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

function describeOutcome(outcome: WriteOutcome): string {
  switch (outcome.kind) {
    case 'applied':
      return 'applied';
    case 'condition_failed':
      return `condition_failed at action ${String(outcome.failed_action_index)}${outcome.existing === undefined ? ' without a decodable existing item' : ''}`;
    case 'definitive_failure':
    case 'ambiguous':
      return `${outcome.kind} ${outcome.code}`;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : `a non-Error ${typeof error}`;
}
