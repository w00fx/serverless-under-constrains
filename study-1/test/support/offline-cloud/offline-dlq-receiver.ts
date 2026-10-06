// Offline stand-in for SQS `ReceiveMessage` on a FIFO dead-letter queue with a zero visibility
// timeout (design §5.3 `DlqReceiver`): every receive returns the queue's head messages again, at
// most 10, without hiding or deleting them, with the attributes SQS reports. Attributes come from
// the offline message log, because the in-memory queue keeps only delivery state; a message sent
// around the log has no attributes and is returned without them, as a malformed message.
//
// Test hook: `failNext(code)` makes the next receive fail with `code`.

import type { CollectorReadFailure } from '../../../src/evidence-collection/collected-records.ts';
import type { DlqReceiver, ReceivedSqsMessage } from '../../../src/evidence-collection/dlq-capture.ts';
import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import type { FifoStoredMessage, InMemoryFifoQueue } from '../fifo-queue/in-memory-fifo-queue.ts';
import type { OfflineMessageLog } from './offline-message-log.ts';

/** The SQS ReceiveMessage limit. */
export const RECEIVE_BATCH_LIMIT = 10;

export class OfflineDlqReceiver implements DlqReceiver {
  readonly #queues: ReadonlyMap<string, InMemoryFifoQueue>;
  readonly #log: OfflineMessageLog;
  #failure: string | undefined;

  /** `queues` maps each DLQ URL to the queue it names. */
  constructor(queues: ReadonlyMap<string, InMemoryFifoQueue>, log: OfflineMessageLog) {
    this.#queues = queues;
    this.#log = log;
  }

  receiveBatch(queueUrl: string): Promise<Result<readonly ReceivedSqsMessage[], CollectorReadFailure>> {
    const failure = this.#failure;
    this.#failure = undefined;
    const queue = this.#queues.get(queueUrl);
    if (failure !== undefined || queue === undefined) {
      return Promise.resolve(err({ code: failure ?? 'AWS.SimpleQueueService.NonExistentQueue' }));
    }
    return Promise.resolve(
      ok(
        queue
          .messages()
          .slice(0, RECEIVE_BATCH_LIMIT)
          .map((message) => this.#received(message)),
      ),
    );
  }

  /** The next receive fails with `code`. */
  failNext(code: string): void {
    this.#failure = code;
  }

  #received(message: FifoStoredMessage): ReceivedSqsMessage {
    const logged = this.#log.find(message.message_id);
    if (logged === undefined) {
      return { MessageId: message.message_id, Body: message.body };
    }
    const firstReceive = this.#log.firstReceivedAt(message.message_id) ?? logged.sent_at_ms;
    return {
      MessageId: message.message_id,
      Body: message.body,
      MD5OfBody: logged.md5_of_body,
      Attributes: {
        ApproximateReceiveCount: String(Math.max(message.receive_count, 1)),
        ApproximateFirstReceiveTimestamp: String(firstReceive),
        SentTimestamp: String(logged.sent_at_ms),
        MessageGroupId: logged.message_group_id,
        MessageDeduplicationId: logged.message_deduplication_id,
        SequenceNumber: logged.sequence_number,
      },
    };
  }
}
