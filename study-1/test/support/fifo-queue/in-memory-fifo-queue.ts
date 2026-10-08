// Offline emulator of an SQS FIFO queue with a redrive policy, on an injected clock (design
// §12.2; the facts are design/aws-semantics.md §3 unless marked):
// - one message group delivers one message at a time: while the group's head message is in
//   flight, nothing else of that group is received;
// - a receive makes the message invisible for the visibility timeout and increments its receive
//   count; a message that is not deleted becomes visible again when the timeout expires
//   (evaluated lazily on the next operation);
// - "When the ReceiveCount for a message exceeds the maxReceiveCount ... SQS moves the message to
//   the DLQ": the move happens on the receive that would exceed it, and "the original message ID
//   is retained";
// - a send with a deduplication id seen within the 5-minute deduplication interval is accepted
//   but not delivered again (design §0 verified fact RF V8 / CF V-5, which cites the SQS
//   SendMessageBatchRequestEntry reference), and answers with the original message id (SQS FIFO
//   developer guide, exactly-once processing; that answer is not in the verified facts);
// - approximate counters lag the true state by `counterLagMs` ("may not achieve consistency until
//   at least 1 minute after the producers stop sending messages", RK-14).

import type { UuidSource, WallClock } from '../../../src/record-contract/primitives.ts';

/** SQS FIFO deduplication interval. */
export const DEDUPLICATION_INTERVAL_MS = 300_000;

export interface FifoQueueOptions {
  readonly clock: WallClock;
  /** Message ids and receipt handles. */
  readonly ids: UuidSource;
  readonly visibilityTimeoutMs: number;
  /** The redrive policy: `maxReceiveCount` and its dead-letter queue; absent for a DLQ. */
  readonly redrive?: { readonly maxReceiveCount: number; readonly deadLetterQueue: InMemoryFifoQueue };
  /** How far behind the true state the approximate counters are (RK-14). */
  readonly counterLagMs?: number;
}

export interface FifoSendInput {
  readonly body: string;
  readonly message_group_id: string;
  readonly message_deduplication_id: string;
}

export interface FifoSendResult {
  readonly message_id: string;
  /** True when the deduplication id was seen within the interval and nothing was enqueued. */
  readonly deduplicated: boolean;
}

export interface FifoReceivedMessage {
  readonly message_id: string;
  readonly receipt_handle: string;
  readonly body: string;
  readonly message_group_id: string;
  readonly message_deduplication_id: string;
  readonly approximate_receive_count: number;
  readonly sent_at_ms: number;
  readonly first_received_at_ms: number;
}

/** A message as the queue holds it, for assertions. */
export interface FifoStoredMessage {
  readonly message_id: string;
  readonly body: string;
  readonly message_group_id: string;
  readonly receive_count: number;
  readonly in_flight: boolean;
}

export interface FifoApproximateCounters {
  readonly visible: number;
  readonly in_flight: number;
}

interface QueuedMessage {
  readonly message_id: string;
  readonly body: string;
  readonly message_group_id: string;
  readonly message_deduplication_id: string;
  readonly sent_at_ms: number;
  receive_count: number;
  first_received_at_ms: number | undefined;
  invisible_until_ms: number;
  receipt_handle: string | undefined;
}

interface CounterSnapshot extends FifoApproximateCounters {
  readonly at_ms: number;
}

export class InMemoryFifoQueue {
  readonly #options: FifoQueueOptions;
  readonly #messages: QueuedMessage[] = [];
  readonly #deduplication = new Map<string, { readonly message_id: string; readonly at_ms: number }>();
  readonly #snapshots: CounterSnapshot[] = [];

  /** Throws a RangeError for a negative visibility timeout or a maxReceiveCount below 1. */
  constructor(options: FifoQueueOptions) {
    if (!Number.isSafeInteger(options.visibilityTimeoutMs) || options.visibilityTimeoutMs < 0) {
      throw new RangeError(
        `visibilityTimeoutMs ${String(options.visibilityTimeoutMs)}; expected a nonnegative safe integer`,
      );
    }
    const maxReceiveCount = options.redrive?.maxReceiveCount ?? 1;
    if (!Number.isSafeInteger(maxReceiveCount) || maxReceiveCount < 1) {
      throw new RangeError(`maxReceiveCount ${String(maxReceiveCount)}; expected a positive safe integer`);
    }
    this.#options = options;
    this.#snapshot();
  }

  /**
   * Enqueues a message, unless its deduplication id was sent within the last 5 minutes.
   *
   * @example
   * queue.send({ body, message_group_id: trialId, message_deduplication_id: trialId });
   */
  send(input: FifoSendInput): FifoSendResult {
    const now = this.#now();
    const seen = this.#deduplication.get(input.message_deduplication_id);
    if (seen !== undefined && now - seen.at_ms < DEDUPLICATION_INTERVAL_MS) {
      return { message_id: seen.message_id, deduplicated: true };
    }
    const messageId = this.#options.ids.next();
    this.#deduplication.set(input.message_deduplication_id, { message_id: messageId, at_ms: now });
    this.#enqueue({ ...input, message_id: messageId, sent_at_ms: now, receive_count: 0 });
    return { message_id: messageId, deduplicated: false };
  }

  /**
   * Receives at most one message (batch size 1), applying the redrive policy first.
   *
   * @example
   * const message = queue.receive(); // undefined while the only group is in flight
   */
  receive(): FifoReceivedMessage | undefined {
    const now = this.#now();
    for (const head of this.#groupHeads()) {
      const message = this.#deliverOrRedrive(head, now);
      if (message !== undefined) {
        return message;
      }
    }
    return undefined;
  }

  /**
   * Deletes the message the receipt handle of its latest receive names; false otherwise.
   *
   * @example
   * queue.deleteMessage(message.receipt_handle); // true after a successful invocation
   */
  deleteMessage(receiptHandle: string): boolean {
    const index = this.#messages.findIndex((message) => message.receipt_handle === receiptHandle);
    if (index === -1) {
      return false;
    }
    this.#messages.splice(index, 1);
    this.#snapshot();
    return true;
  }

  /**
   * The counters as they stood `counterLagMs` ago (RK-14); zeros before the first snapshot that old.
   *
   * @example
   * queue.approximateCounters(); // { visible: 1, in_flight: 0 } a minute after the send
   */
  approximateCounters(): FifoApproximateCounters {
    const cutoff = this.#now() - (this.#options.counterLagMs ?? 0);
    const visibleSnapshot = this.#snapshots.findLast((snapshot) => snapshot.at_ms <= cutoff);
    return visibleSnapshot === undefined
      ? { visible: 0, in_flight: 0 }
      : { visible: visibleSnapshot.visible, in_flight: visibleSnapshot.in_flight };
  }

  /**
   * Every message the queue holds, in send order.
   *
   * @example
   * dlq.messages().map((message) => message.message_id); // the original source message id
   */
  messages(): readonly FifoStoredMessage[] {
    const now = this.#now();
    return this.#messages.map((message) => ({
      message_id: message.message_id,
      body: message.body,
      message_group_id: message.message_group_id,
      receive_count: message.receive_count,
      in_flight: message.invisible_until_ms > now,
    }));
  }

  /** Accepts a message the source's redrive policy moved here, keeping its id and count. */
  acceptRedriven(message: Omit<QueuedMessage, 'invisible_until_ms' | 'receipt_handle' | 'first_received_at_ms'>): void {
    this.#enqueue(message);
  }

  #enqueue(message: Omit<QueuedMessage, 'invisible_until_ms' | 'receipt_handle' | 'first_received_at_ms'>): void {
    this.#messages.push({
      ...message,
      first_received_at_ms: undefined,
      invisible_until_ms: 0,
      receipt_handle: undefined,
    });
    this.#snapshot();
  }

  // The first message of each group, in send order: only a group's head can be delivered.
  #groupHeads(): readonly QueuedMessage[] {
    const seen = new Set<string>();
    return this.#messages.filter((message) => {
      const first = !seen.has(message.message_group_id);
      seen.add(message.message_group_id);
      return first;
    });
  }

  #deliverOrRedrive(head: QueuedMessage, now: number): FifoReceivedMessage | undefined {
    if (head.invisible_until_ms > now) {
      return undefined;
    }
    const redrive = this.#options.redrive;
    if (redrive !== undefined && head.receive_count >= redrive.maxReceiveCount) {
      this.#messages.splice(this.#messages.indexOf(head), 1);
      redrive.deadLetterQueue.acceptRedriven(head);
      this.#snapshot();
      return this.receive();
    }
    head.receive_count += 1;
    head.first_received_at_ms ??= now;
    head.invisible_until_ms = now + this.#options.visibilityTimeoutMs;
    head.receipt_handle = this.#options.ids.next();
    this.#snapshot();
    return {
      message_id: head.message_id,
      receipt_handle: head.receipt_handle,
      body: head.body,
      message_group_id: head.message_group_id,
      message_deduplication_id: head.message_deduplication_id,
      approximate_receive_count: head.receive_count,
      sent_at_ms: head.sent_at_ms,
      first_received_at_ms: head.first_received_at_ms,
    };
  }

  #snapshot(): void {
    const now = this.#now();
    const inFlight = this.#messages.filter((message) => message.invisible_until_ms > now).length;
    this.#snapshots.push({ at_ms: now, visible: this.#messages.length - inFlight, in_flight: inFlight });
  }

  #now(): number {
    return this.#options.clock.now().getTime();
  }
}
