// The offline SQS service's own record of every message sent through it (design §12.2). The
// in-memory FIFO queue models delivery, visibility and redrive; this log keeps what SQS also
// reports about a message and the queue does not: its FIFO sequence number, sent timestamp,
// deduplication id and first receive instant. The publisher and the stray-message injections send
// through it, the event source mapping pump notes receives in it, and the DLQ receiver reads the
// attributes of a redriven message back from it.

import { createHash } from 'node:crypto';

import type { WallClock } from '../../../src/record-contract/primitives.ts';
import type { FifoSendInput, InMemoryFifoQueue } from '../fifo-queue/in-memory-fifo-queue.ts';

/** What SQS knows about one sent message. */
export interface LoggedMessage {
  readonly message_id: string;
  readonly body: string;
  readonly message_group_id: string;
  readonly message_deduplication_id: string;
  readonly sent_at_ms: number;
  /** The FIFO sequence number: 20 decimal digits, increasing with every accepted send. */
  readonly sequence_number: string;
  /** SQS `MD5OfMessageBody`, lowercase hex. */
  readonly md5_of_body: string;
}

const SEQUENCE_BASE = 18_000_000_000_000_000_000n;

export class OfflineMessageLog {
  readonly #clock: WallClock;
  readonly #messages = new Map<string, LoggedMessage>();
  readonly #firstReceives = new Map<string, number>();

  constructor(clock: WallClock) {
    this.#clock = clock;
  }

  /**
   * Sends through `queue` and logs the message; a deduplicated send returns the first message.
   *
   * @example
   * const sent = log.send(source, { body, message_group_id: trialId, message_deduplication_id: trialId });
   */
  send(queue: InMemoryFifoQueue, input: FifoSendInput): LoggedMessage {
    const sent = queue.send(input);
    const known = this.#messages.get(sent.message_id);
    if (known !== undefined) {
      return known;
    }
    const logged: LoggedMessage = {
      ...input,
      message_id: sent.message_id,
      sent_at_ms: this.#clock.now().getTime(),
      sequence_number: String(SEQUENCE_BASE + BigInt(this.#messages.size + 1)),
      md5_of_body: createHash('md5').update(input.body).digest('hex'),
    };
    this.#messages.set(sent.message_id, logged);
    return logged;
  }

  /** Records a receive; only the first one of a message is kept. */
  noteReceived(messageId: string, atMs: number): void {
    if (!this.#firstReceives.has(messageId)) {
      this.#firstReceives.set(messageId, atMs);
    }
  }

  /** The logged message, or `undefined` for a message not sent through the log. */
  find(messageId: string): LoggedMessage | undefined {
    return this.#messages.get(messageId);
  }

  /** The first receive instant, or `undefined` when the message was never received. */
  firstReceivedAt(messageId: string): number | undefined {
    return this.#firstReceives.get(messageId);
  }
}
