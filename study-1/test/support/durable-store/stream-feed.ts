// Emulator of a DynamoDB Streams event source mapping feeding one Lambda consumer
// (design §12.2 `StreamFeed`, §9.5 controller column). Documented behavior it reproduces:
// - one stream record per modified item, INSERT or MODIFY, with `NEW_IMAGE` only
//   (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html);
// - one shard lane: records are delivered in order and never reordered, one per batch
//   (`BatchSize: 1`), and a delayed or retried record holds back every later one;
// - filter patterns on the metadata properties `eventName` and `dynamodb` (F-2); records
//   that do not match are skipped and the iterator advances;
// - at-least-once delivery: `duplicateNext()` re-delivers a record with the same `eventID`
//   (https://docs.aws.amazon.com/lambda/latest/dg/with-ddb.html);
// - readiness lag: an `Enabled` mapping may take time to start polling; with `TRIM_HORIZON`
//   records written meanwhile are still delivered once polling starts (with-ddb.html);
// - a consumer error is retried up to `MaximumRetryAttempts`, then the record goes to the
//   on-failure destination as batch metadata, not the record, and the shard advances
//   (https://docs.aws.amazon.com/lambda/latest/dg/services-dynamodb-errors.html).
// Time moves only through the injected scheduler, so tests drive it with virtual time.

import type { AttributeValue as LambdaAttributeValue, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

import { encodeAttributeMap } from '../../../src/durable-store/attribute-value-codec.ts';
import type { TableRole } from '../../../src/durable-store/item-store-port.ts';
import type { JsonObject, JsonValue, TimerScheduler, WallClock } from '../../../src/record-contract/primitives.ts';
import type { ItemChange, ItemChangeSource } from './in-memory-item-store.ts';
import { parseFilterPatterns, passesFilters } from './stream-filter.ts';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 2;
export const SHARD_ID = 'shardId-00000000000000000001-00000001';

export interface StreamFeedOptions {
  readonly source: ItemChangeSource;
  readonly table: TableRole;
  readonly scheduler: TimerScheduler;
  readonly clock: WallClock;
  readonly consumer: (event: DynamoDBStreamEvent) => Promise<void>;
  readonly filters?: readonly (string | JsonObject)[];
  readonly readinessLagMs?: number;
  readonly maxRetryAttempts?: number;
  readonly region?: string;
  readonly streamArn?: string;
}

export interface StreamDeliveryAttempt {
  readonly event_id: string;
  readonly sequence_number: string;
  readonly event_name: 'INSERT' | 'MODIFY';
  readonly attempt: number;
  readonly outcome: 'succeeded' | 'failed';
}

/** What the on-failure destination receives: batch metadata, never the record itself. */
export interface OnFailureRecord {
  readonly shard_id: string;
  readonly start_sequence_number: string;
  readonly end_sequence_number: string;
  readonly batch_size: 1;
  readonly attempts: number;
}

interface PendingRecord {
  readonly record: DynamoDBRecord;
  readonly event_id: string;
  readonly sequence_number: string;
  readonly event_name: 'INSERT' | 'MODIFY';
  attempts: number;
  failures: number;
  // 0 until the record first reaches the head; then 1, or 2 when duplicateNext() armed it.
  deliveriesRemaining: number;
}

export class StreamFeed {
  readonly #options: StreamFeedOptions;
  readonly #filters: readonly JsonObject[];
  readonly #maxRetryAttempts: number;
  readonly #unsubscribe: () => void;
  readonly #queue: PendingRecord[] = [];
  readonly #deliveries: StreamDeliveryAttempt[] = [];
  readonly #onFailure: OnFailureRecord[] = [];
  #sequence = 0;
  #skipped = 0;
  #enabled = false;
  #polling = false;
  #busy = false;
  #nextDelayMs = 0;
  #duplicatePending = false;

  constructor(options: StreamFeedOptions) {
    this.#options = options;
    this.#filters = parseFilterPatterns(options.filters ?? []);
    this.#maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
    nonNegativeInteger('maxRetryAttempts', this.#maxRetryAttempts);
    nonNegativeInteger('readinessLagMs', options.readinessLagMs ?? 0);
    this.#unsubscribe = options.source.subscribe(options.table, (change) => {
      this.#append(change);
    });
  }

  /** Sets the mapping `Enabled`; polling starts after the readiness lag. */
  enable(): void {
    if (this.#enabled) {
      throw new Error('enable() called twice; expected one transition of the mapping to Enabled');
    }
    this.#enabled = true;
    this.#options.scheduler.schedule(this.#options.readinessLagMs ?? 0, () => {
      this.#polling = true;
      this.#kick();
    });
  }

  isEnabled(): boolean {
    return this.#enabled;
  }

  isPolling(): boolean {
    return this.#polling;
  }

  /** The next record to be delivered is delivered twice, with the same eventID. */
  duplicateNext(): void {
    this.#duplicatePending = true;
  }

  /** The next record to be delivered waits `ms` more; every later record waits behind it. */
  delay(ms: number): void {
    nonNegativeInteger('delay', ms);
    this.#nextDelayMs = ms;
  }

  /** Stops receiving stream records (the table stream is unaffected). */
  close(): void {
    this.#unsubscribe();
  }

  deliveries(): readonly StreamDeliveryAttempt[] {
    return [...this.#deliveries];
  }

  onFailureRecords(): readonly OnFailureRecord[] {
    return [...this.#onFailure];
  }

  skippedCount(): number {
    return this.#skipped;
  }

  pendingCount(): number {
    return this.#queue.length;
  }

  #append(change: ItemChange): void {
    this.#sequence += 1;
    const sequenceNumber = String(this.#sequence).padStart(21, '0');
    const keys = lambdaImage({ pk: change.keys.pk, sk: change.keys.sk });
    const newImage = lambdaImage(change.new_image);
    const eventId = this.#sequence.toString(16).padStart(32, '0');
    const record: DynamoDBRecord = {
      eventID: eventId,
      eventName: change.event_name,
      eventVersion: '1.1',
      eventSource: 'aws:dynamodb',
      awsRegion: this.#options.region ?? 'us-east-1',
      dynamodb: {
        ApproximateCreationDateTime: Math.floor(this.#options.clock.now().getTime() / 1000),
        Keys: keys,
        NewImage: newImage,
        SequenceNumber: sequenceNumber,
        SizeBytes: Buffer.byteLength(JSON.stringify(keys) + JSON.stringify(newImage)),
        StreamViewType: 'NEW_IMAGE',
      },
      eventSourceARN: this.#options.streamArn ?? `arn:aws:dynamodb:us-east-1:000000000000:table/${change.table}/stream`,
    };
    this.#queue.push({
      record,
      event_id: eventId,
      sequence_number: sequenceNumber,
      event_name: change.event_name,
      attempts: 0,
      failures: 0,
      deliveriesRemaining: 0,
    });
    this.#kick();
  }

  #kick(): void {
    if (!this.#polling || this.#busy) {
      return;
    }
    this.#busy = true;
    this.#scheduleHead();
  }

  #scheduleHead(): void {
    while (this.#queue[0] !== undefined && !passesFilters(this.#filters, this.#queue[0].record as JsonValue)) {
      this.#queue.shift();
      this.#skipped += 1;
    }
    const head = this.#queue[0];
    if (head === undefined) {
      this.#busy = false;
      return;
    }
    let delayMs = 0;
    if (head.deliveriesRemaining === 0) {
      head.deliveriesRemaining = this.#duplicatePending ? 2 : 1;
      this.#duplicatePending = false;
      delayMs = this.#nextDelayMs;
      this.#nextDelayMs = 0;
    }
    this.#options.scheduler.schedule(delayMs, () => {
      void this.#deliver(head);
    });
  }

  async #deliver(head: PendingRecord): Promise<void> {
    head.attempts += 1;
    const succeeded = await this.#invokeConsumer(head.record);
    this.#deliveries.push({
      event_id: head.event_id,
      sequence_number: head.sequence_number,
      event_name: head.event_name,
      attempt: head.attempts,
      outcome: succeeded ? 'succeeded' : 'failed',
    });
    this.#settle(head, succeeded);
    this.#scheduleHead();
  }

  #settle(head: PendingRecord, succeeded: boolean): void {
    if (succeeded) {
      head.deliveriesRemaining -= 1;
      if (head.deliveriesRemaining === 0) {
        this.#queue.shift();
      }
      return;
    }
    head.failures += 1;
    if (head.failures > this.#maxRetryAttempts) {
      this.#onFailure.push({
        shard_id: SHARD_ID,
        start_sequence_number: head.sequence_number,
        end_sequence_number: head.sequence_number,
        batch_size: 1,
        attempts: head.attempts,
      });
      this.#queue.shift();
    }
  }

  async #invokeConsumer(record: DynamoDBRecord): Promise<boolean> {
    try {
      await this.#options.consumer({ Records: [structuredClone(record)] });
      return true;
    } catch {
      return false;
    }
  }
}

// The codec emits only S, N, BOOL, NULL, L and M, whose JSON shapes are identical in the SDK
// and in Lambda stream events; only binary differs (Uint8Array versus base64), and it never occurs.
function lambdaImage(attributes: JsonObject): Record<string, LambdaAttributeValue> {
  return encodeAttributeMap(attributes) as Record<string, LambdaAttributeValue>;
}

function nonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} ${String(value)}; expected a nonnegative safe integer`);
  }
}
