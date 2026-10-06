// What a simulated trial did, on the golden timeline: the facts the settlement observer and the
// evidence collector read back at a given instant. The simulation appends facts as it emits
// journal events; settlement samples, queue observations and the frozen snapshots are all queries
// over these facts, so a sample can never disagree with the journals it summarizes.

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import type { LoggedEvent } from './golden-event-log.ts';

/** One ledger transaction and the instant its commit applied. */
export interface LedgerFact {
  readonly at_ms: number;
  readonly transaction: JsonObject;
}

/** One provider call, active from its receipt until its terminal provider event (design §9.3). */
export interface ProviderCallFact {
  readonly from_ms: number;
  readonly until_ms: number;
}

/** One version of the treatment item and the instant it was written. */
export interface TreatmentFact {
  readonly at_ms: number;
  readonly item: JsonObject;
}

/** How the trial message sits in its source queue during one interval. */
export interface QueueSpan {
  readonly state: 'visible' | 'in_flight';
  readonly from_ms: number;
  /** Absent when the interval is still open at the end of the simulation. */
  readonly until_ms?: number;
}

/** One Durable history event and its instant. */
export interface DurableHistoryFact {
  readonly at_ms: number;
  readonly event: JsonObject;
}

/** One Durable execution: its identity, how it ends (if it does) and its history. */
export interface DurableExecutionFact {
  readonly arn: string;
  readonly name: string;
  readonly started_ms: number;
  /** Absent while the execution is still running at the end of the simulation. */
  readonly end?: { readonly at_ms: number; readonly status: 'SUCCEEDED' | 'FAILED' };
  readonly history: readonly DurableHistoryFact[];
}

/** Queue counters at an instant (BR-RUA-032). */
export interface CounterValues {
  readonly visible: number;
  readonly in_flight: number;
  readonly delayed: number;
}

/**
 * The facts of one trial (or the probe), appended in simulation order and queried by instant.
 *
 * @example
 * const timeline = new TrialTimeline();
 * timeline.addLedger(1080, transaction);
 * timeline.ledgerAt(2000).length; // 1
 */
export class TrialTimeline {
  readonly #ledger: LedgerFact[] = [];
  readonly #calls: ProviderCallFact[] = [];
  readonly #treatment: TreatmentFact[] = [];
  readonly #finished: number[] = [];
  readonly #queue: QueueSpan[] = [];
  readonly #durable: DurableExecutionFact[] = [];
  #dlqArrivalMs: number | undefined;

  /**
   * Records a committed ledger transaction.
   *
   * @example
   * timeline.addLedger(commitMs, { provider_transaction_id, ... });
   */
  addLedger(atMs: number, transaction: JsonObject): void {
    this.#ledger.push({ at_ms: atMs, transaction });
  }

  /**
   * Records a provider call's active interval.
   *
   * @example
   * timeline.addProviderCall(receivedMs, terminalMs);
   */
  addProviderCall(fromMs: number, untilMs: number): void {
    this.#calls.push({ from_ms: fromMs, until_ms: untilMs });
  }

  /**
   * Records one treatment-item version.
   *
   * @example
   * timeline.addTreatment(armedMs, { state: 'ARMED', version: 1 });
   */
  addTreatment(atMs: number, item: JsonObject): void {
    this.#treatment.push({ at_ms: atMs, item });
  }

  /**
   * Records that processing reached FINISHED at `atMs`.
   *
   * @example
   * timeline.addFinished(stateMs);
   */
  addFinished(atMs: number): void {
    this.#finished.push(atMs);
  }

  /**
   * Records how the message sits in the source queue from `fromMs` on.
   *
   * @example
   * timeline.addQueueSpan({ state: 'in_flight', from_ms: receiveMs, until_ms: deleteMs });
   */
  addQueueSpan(span: QueueSpan): void {
    this.#queue.push(span);
  }

  /**
   * Records the redrive of the message into the DLQ.
   *
   * @example
   * timeline.moveToDlq(visibilityExpiryMs);
   */
  moveToDlq(atMs: number): void {
    this.#dlqArrivalMs = atMs;
  }

  /**
   * When the message reached the DLQ, if it did.
   *
   * @example
   * timeline.dlqArrivalMs(); // undefined for a trial that finished
   */
  dlqArrivalMs(): number | undefined {
    return this.#dlqArrivalMs;
  }

  /**
   * Records one Durable execution.
   *
   * @example
   * timeline.addDurableExecution({ arn, name, started_ms, end: { at_ms, status: 'SUCCEEDED' }, history });
   */
  addDurableExecution(execution: DurableExecutionFact): void {
    this.#durable.push(execution);
  }

  /**
   * Every Durable execution, in start order.
   *
   * @example
   * timeline.durableExecutions().length; // 1 for the nominal Durable treatment
   */
  durableExecutions(): readonly DurableExecutionFact[] {
    return [...this.#durable];
  }

  /**
   * The ledger transactions committed at or before `atMs`.
   *
   * @example
   * timeline.ledgerAt(capturedMs).map((fact) => fact.transaction);
   */
  ledgerAt(atMs: number): readonly LedgerFact[] {
    return this.#ledger.filter((fact) => fact.at_ms <= atMs);
  }

  /**
   * The treatment-item version current at `atMs`, if the item existed then.
   *
   * @example
   * timeline.treatmentAt(capturedMs)?.item;
   */
  treatmentAt(atMs: number): TreatmentFact | undefined {
    return this.#treatment.filter((fact) => fact.at_ms <= atMs).at(-1);
  }

  /**
   * Provider calls still active at `atMs`.
   *
   * @example
   * timeline.activeCallsAt(sampleMs); // 0 once every call has a terminal event
   */
  activeCallsAt(atMs: number): number {
    return this.#calls.filter((call) => call.from_ms <= atMs && atMs < call.until_ms).length;
  }

  /**
   * Whether processing had FINISHED at `atMs`.
   *
   * @example
   * timeline.finishedAt(sampleMs);
   */
  finishedAt(atMs: number): boolean {
    return this.#finished.some((finishedMs) => finishedMs <= atMs);
  }

  /**
   * Whether every Durable execution started by `atMs` had ended by then.
   *
   * @example
   * timeline.innerExecutionsTerminalAt(sampleMs);
   */
  innerExecutionsTerminalAt(atMs: number): boolean {
    return this.#durable
      .filter((execution) => execution.started_ms <= atMs)
      .every((execution) => execution.end !== undefined && execution.end.at_ms <= atMs);
  }

  /**
   * Source-queue counters at `atMs`.
   *
   * @example
   * timeline.sourceCountersAt(sampleMs); // { visible: 0, in_flight: 1, delayed: 0 }
   */
  sourceCountersAt(atMs: number): CounterValues {
    const covering = this.#queue.filter(
      (span) => span.from_ms <= atMs && (span.until_ms === undefined || atMs < span.until_ms),
    );
    return {
      visible: covering.filter((span) => span.state === 'visible').length,
      in_flight: covering.filter((span) => span.state === 'in_flight').length,
      delayed: 0,
    };
  }

  /**
   * DLQ counters at `atMs`: the redriven message stays visible until the collector deletes it
   * after freeze, which is outside every fixture.
   *
   * @example
   * timeline.dlqCountersAt(sampleMs); // { visible: 1, in_flight: 0, delayed: 0 } after a redrive
   */
  dlqCountersAt(atMs: number): CounterValues {
    const arrived = this.#dlqArrivalMs !== undefined && this.#dlqArrivalMs <= atMs;
    return { visible: arrived ? 1 : 0, in_flight: 0, delayed: 0 };
  }
}

/**
 * How many of `events` had happened at or before `atMs`: the correlated-journal watermark of a
 * settlement sample.
 *
 * @example
 * eventsAtOrBefore(log.events(), sampleMs); // 14
 */
export function eventsAtOrBefore(events: readonly LoggedEvent[], atMs: number): number {
  return events.filter((event) => event.at_ms <= atMs).length;
}
