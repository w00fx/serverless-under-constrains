// InMemoryDlqQueue: a model of SQS dead-letter queues behind `DlqQueueAccess`, for the step-8
// sweep (`CapturedDlqMessageDeletion`). It keeps what the sweep's proof depends on:
// - a receive returns at most ten visible messages in queue order and hides each one, with a new
//   receipt handle per receive;
// - in a FIFO queue (URL ending `.fifo`) a group with a hidden message returns nothing more until
//   that message is deleted or released, as SQS FIFO ordering does;
// - a delete or release acts only through the receipt handle of the message's latest receive;
//   a delete through an older handle it issued is accepted and deletes nothing, as SQS
//   `DeleteMessage` documents ("If you use an old ReceiptHandle, the request will succeed, but
//   the message might not be deleted"), while a handle it never issued is refused;
// Time is not modelled: a hidden message stays hidden until it is deleted or released. Faults
// are scripted per queue (a failed receive, a queue that no longer exists) and per message id
// (a failed delete or release). Every call is recorded.

import type {
  DlqMessageChange,
  DlqQueueAccess,
  DlqReceive,
  ReceivedDlqMessage,
} from '../../../../src/cleanup/dlq-message-deletion.ts';
import type { StructuredReason } from '../../../../src/record-contract/primitives.ts';

export interface RecordedDlqCall {
  readonly operation: 'receive' | 'delete' | 'release';
  readonly queue_url: string;
  readonly message_id?: string;
}

interface ModelMessage {
  readonly message_id: string;
  readonly group?: string;
  hidden_by?: string;
}

const RECEIVE_BATCH = 10;

function scriptedReason(code: string, subject: string): StructuredReason {
  return { code, subject, detail: `scripted ${code}; expected success` };
}

/**
 * Dead-letter queues in memory.
 *
 * @example
 * const queues = new InMemoryDlqQueue();
 * queues.enqueue(url, 'm-1', 'trial-1');
 * await new CapturedDlqMessageDeletion(queues, [url]).deleteCaptured(['m-1']);
 */
export class InMemoryDlqQueue implements DlqQueueAccess {
  readonly #queues = new Map<string, ModelMessage[]>();
  readonly #failedReceives = new Map<string, number>();
  readonly #failedDeletes = new Set<string>();
  readonly #failedReleases = new Set<string>();
  readonly #calls: RecordedDlqCall[] = [];
  readonly #issuedReceipts = new Set<string>();
  #receipts = 0;

  /** Adds a message to the end of a queue (created on first use); `group` is its FIFO group. */
  enqueue(queueUrl: string, messageId: string, group?: string): void {
    this.#queue(queueUrl).push({ message_id: messageId, ...(group === undefined ? {} : { group }) });
  }

  /** Creates an empty queue. */
  createQueue(queueUrl: string): void {
    this.#queue(queueUrl);
  }

  /** The queue no longer exists: a receive answers `queue_absent`. */
  removeQueue(queueUrl: string): void {
    this.#queues.delete(queueUrl);
  }

  /** The next `times` receives of this queue fail. */
  failReceives(queueUrl: string, times = 1): void {
    this.#failedReceives.set(queueUrl, times);
  }

  /** Every delete of this message fails. */
  failDeleteOf(messageId: string): void {
    this.#failedDeletes.add(messageId);
  }

  /** Every release of this message fails. */
  failReleaseOf(messageId: string): void {
    this.#failedReleases.add(messageId);
  }

  /** The ids still in a queue, hidden or not, in queue order. */
  messageIds(queueUrl: string): readonly string[] {
    return (this.#queues.get(queueUrl) ?? []).map((message) => message.message_id);
  }

  /** The ids in a queue that a receive would not return because they are hidden. */
  hiddenIds(queueUrl: string): readonly string[] {
    return (this.#queues.get(queueUrl) ?? []).flatMap((message) =>
      message.hidden_by === undefined ? [] : [message.message_id],
    );
  }

  calls(): readonly RecordedDlqCall[] {
    return [...this.#calls];
  }

  receive(queueUrl: string): Promise<DlqReceive> {
    this.#calls.push({ operation: 'receive', queue_url: queueUrl });
    const failures = this.#failedReceives.get(queueUrl) ?? 0;
    if (failures > 0) {
      this.#failedReceives.set(queueUrl, failures - 1);
      return Promise.resolve({ kind: 'failed', reason: scriptedReason('OVER_LIMIT', queueUrl) });
    }
    const queue = this.#queues.get(queueUrl);
    if (queue === undefined) {
      return Promise.resolve({ kind: 'queue_absent' });
    }
    const batch = visibleBatch(queue, queueUrl.endsWith('.fifo'));
    const messages: ReceivedDlqMessage[] = batch.map((message) => {
      this.#receipts += 1;
      message.hidden_by = `receipt-${String(this.#receipts)}`;
      this.#issuedReceipts.add(message.hidden_by);
      return { message_id: message.message_id, receipt_handle: message.hidden_by };
    });
    return Promise.resolve({ kind: 'messages', messages });
  }

  deleteMessage(queueUrl: string, receiptHandle: string): Promise<DlqMessageChange> {
    return Promise.resolve(this.#change('delete', queueUrl, receiptHandle));
  }

  releaseMessage(queueUrl: string, receiptHandle: string): Promise<DlqMessageChange> {
    return Promise.resolve(this.#change('release', queueUrl, receiptHandle));
  }

  #change(operation: 'delete' | 'release', queueUrl: string, receiptHandle: string): DlqMessageChange {
    const queue = this.#queues.get(queueUrl) ?? [];
    const index = queue.findIndex((message) => message.hidden_by === receiptHandle);
    const message = queue[index];
    this.#calls.push({
      operation,
      queue_url: queueUrl,
      ...(message === undefined ? {} : { message_id: message.message_id }),
    });
    if (message === undefined) {
      return operation === 'delete' && this.#issuedReceipts.has(receiptHandle)
        ? { kind: 'done' }
        : { kind: 'failed', reason: scriptedReason('RECEIPT_HANDLE_IS_INVALID', receiptHandle) };
    }
    const failing = operation === 'delete' ? this.#failedDeletes : this.#failedReleases;
    if (failing.has(message.message_id)) {
      return { kind: 'failed', reason: scriptedReason('INTERNAL_ERROR', message.message_id) };
    }
    if (operation === 'delete') {
      queue.splice(index, 1);
    } else {
      delete message.hidden_by;
    }
    return { kind: 'done' };
  }

  #queue(queueUrl: string): ModelMessage[] {
    const existing = this.#queues.get(queueUrl);
    if (existing !== undefined) {
      return existing;
    }
    const created: ModelMessage[] = [];
    this.#queues.set(queueUrl, created);
    return created;
  }
}

// At most ten visible messages in queue order; in a FIFO queue none of a group that has a hidden
// message (one receive may still return several messages of one group, in order).
function visibleBatch(queue: readonly ModelMessage[], fifo: boolean): ModelMessage[] {
  const blocked = new Set(
    queue.flatMap((message) =>
      fifo && message.hidden_by !== undefined && message.group !== undefined ? [message.group] : [],
    ),
  );
  return queue
    .filter(
      (message) => message.hidden_by === undefined && !(message.group !== undefined && blocked.has(message.group)),
    )
    .slice(0, RECEIVE_BATCH);
}
