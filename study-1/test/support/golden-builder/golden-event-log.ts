// Journal events of a golden scenario with the BR-RUA-033 envelope: a fresh lowercase UUIDv4 per
// event, the execution identity and manifest digest, the trial pair on trial-scoped events, and a
// `source_sequence` dense from 1 within each `(source, source_instance_id)`. Writers serialize their
// appends, so a source instance emits in time order; `causation_event_ids` is sorted, unique and
// omitted for causal roots.

import { causationIds } from '../../../src/record-contract/envelope.ts';
import type { EventSource, ExecutionIdentityFields } from '../../../src/record-contract/envelope.ts';
import type { JsonObject, Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import type { EventRecordType } from '../../../src/record-contract/record-types.ts';
import { goldenUuid, instantAt } from './golden-values.ts';

/** Where the events of one log belong: an execution, and optionally one of its trials. */
export interface EventLogScope {
  /** Prefix of every id label of the log, unique per execution and partition. */
  readonly label: string;
  readonly identity: ExecutionIdentityFields;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly trial?: { readonly trial_id: Uuid4; readonly trial_manifest_sha256: Sha256Hex };
}

/** One emitted event: its record and its emission time on the golden timeline. */
export interface LoggedEvent {
  readonly at_ms: number;
  readonly record: JsonObject;
}

/**
 * The events of one partition, emitted through source instances.
 *
 * @example
 * const log = new GoldenEventLog(scope);
 * const caller = log.instance('conventional_caller', 'delivery-1');
 * const started = caller.emit('caller_invocation_started', 400, { lambda_request_id: 'r' });
 */
export class GoldenEventLog {
  readonly #scope: EventLogScope;
  readonly #events: LoggedEvent[] = [];
  readonly #instances = new Set<string>();

  constructor(scope: EventLogScope) {
    this.#scope = scope;
  }

  /**
   * Opens a new source instance; a label names it once per source, because a restart creates a
   * new instance (BR-RUA-033).
   *
   * @example
   * const provider = log.instance('refund_provider', 'call-1');
   */
  instance(source: EventSource, label: string): GoldenSourceInstance {
    const key = `${source}/${label}`;
    if (this.#instances.has(key)) {
      throw new RangeError(`source instance ${key} opened twice; expected a fresh label per instance`);
    }
    this.#instances.add(key);
    return new GoldenSourceInstance(this.#scope, source, key, (event) => {
      this.#events.push(event);
    });
  }

  /**
   * Every event emitted so far, in emission order.
   *
   * @example
   * log.events().map((event) => event.record['record_type']);
   */
  events(): readonly LoggedEvent[] {
    return [...this.#events];
  }
}

/**
 * One source instance: it assigns dense sequences and refuses to go back in time.
 *
 * @example
 * const id = instance.emit('dispatch_started', 440, body, [registeredId]);
 */
export class GoldenSourceInstance {
  readonly #scope: EventLogScope;
  readonly #source: EventSource;
  readonly #label: string;
  readonly #sink: (event: LoggedEvent) => void;
  readonly instance_id: Uuid4;
  #sequence = 0;
  #lastAt = 0;

  constructor(scope: EventLogScope, source: EventSource, label: string, sink: (event: LoggedEvent) => void) {
    this.#scope = scope;
    this.#source = source;
    this.#label = label;
    this.#sink = sink;
    this.instance_id = goldenUuid(`${scope.label}/instance/${label}`);
  }

  /**
   * Appends one event at `atMs` and returns its `event_id`.
   *
   * @example
   * const received = provider.emit('provider_call_received', 500, { provider_call_id, raw_request_sha256 });
   */
  emit(recordType: EventRecordType, atMs: number, body: JsonObject, causation: readonly Uuid4[] = []): Uuid4 {
    if (atMs < this.#lastAt) {
      throw new RangeError(
        `${this.#label} emits ${recordType} at ${String(atMs)} ms after an event at ${String(this.#lastAt)} ms; expected time order within a source instance`,
      );
    }
    this.#lastAt = atMs;
    this.#sequence += 1;
    const eventId = goldenUuid(`${this.#scope.label}/event/${this.#label}/${String(this.#sequence)}`);
    const causes = causationIds(causation);
    const record: JsonObject = {
      ...body,
      schema_version: 1,
      record_type: recordType,
      event_id: eventId,
      ...this.#scope.identity,
      execution_manifest_sha256: this.#scope.execution_manifest_sha256,
      ...(this.#scope.trial ?? {}),
      occurred_at: instantAt(atMs),
      source: this.#source,
      source_instance_id: this.instance_id,
      source_sequence: this.#sequence,
      ...(causes === undefined ? {} : { causation_event_ids: causes }),
    };
    this.#sink({ at_ms: atMs, record });
    return eventId;
  }
}

/**
 * Orders journal lines as the collector exports them: by the base-table sort key
 * `<source>#<source_instance_id>#<source_sequence:12>` (design §9.3).
 *
 * @example
 * const lines = sortedJournal(log.events().filter(isProviderEvent));
 */
export function sortedJournal(events: readonly LoggedEvent[]): readonly JsonObject[] {
  return events
    .map((event) => ({ key: sortKeyOf(event.record), record: event.record }))
    .toSorted((a, b) => compareCodeUnits(a.key, b.key))
    .map((entry) => entry.record);
}

/**
 * Orders two strings by UTF-16 code units, the order DynamoDB sorts string keys in and the order
 * of canonical JSON keys; locale-independent, so fixture bytes never depend on the ICU version.
 *
 * @example
 * ['b', 'a'].toSorted(compareCodeUnits); // ['a', 'b']
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function sortKeyOf(record: JsonObject): string {
  const sequence = recordText(record, 'source_sequence').padStart(12, '0');
  return `${recordText(record, 'source')}#${recordText(record, 'source_instance_id')}#${sequence}`;
}

/**
 * The text of a string or number member of a record; empty for any other value.
 *
 * @example
 * recordText({ source: 'runner' }, 'source'); // 'runner'
 * recordText({ source_sequence: 3 }, 'source_sequence'); // '3'
 */
export function recordText(record: JsonObject, key: string): string {
  const value = record[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
