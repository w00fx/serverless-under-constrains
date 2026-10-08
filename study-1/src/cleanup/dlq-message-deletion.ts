// Step 8 against SQS (BR-RUA-048 "deletes captured run-owned DLQ messages"; design §10.4): the
// pure decisions behind the production `DlqMessagePort`. SQS deletes a message by the receipt
// handle of a receive, while the capture of step 7 reports only message ids, so each bound DLQ is
// swept in bounded rounds of receive, then delete or hold:
// - a received message whose id was captured is deleted with that receive's handle (a duplicate
//   delivery of one already deleted is deleted too);
// - any other message is held (left hidden by the receive) until the sweep ends, then released
//   (visibility 0), never deleted. Releasing it at once would make the next receive return it
//   again, so the sweep could never end in an empty receive;
// - a captured message that failed to delete is reported failed and held and released likewise;
// - a captured id counts as absent only after every bound queue's sweep ended in an empty
//   receive (or the queue no longer exists). A sweep that fails or runs out of rounds proves
//   nothing, and neither does an empty receive of a FIFO queue while the sweep holds a message:
//   FIFO hides the rest of a held message's group, which may hold a captured one. Every captured
//   id not found then fails with that reason instead.
// A release that fails is not reported: the message becomes visible again when its hold timeout
// ends, and the proof of absence was decided before the release.

import { boundedText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { DlqDeletionReport, DlqMessagePort } from './cleanup-ports.ts';

/** Messages one receive asks for (the SQS maximum). */
export const DLQ_RECEIVE_BATCH = 10;
/** How long a received message stays hidden while the sweep holds it, in seconds. */
export const DLQ_HOLD_VISIBILITY_SECONDS = 60;
/** Long polling: an empty answer then means no message is visible, not a sampled miss. */
export const DLQ_RECEIVE_WAIT_SECONDS = 20;
/** Receives per queue in one deletion before its sweep is given up as incomplete. */
export const MAX_DLQ_RECEIVES_PER_QUEUE = 20;

const FIFO_QUEUE_SUFFIX = '.fifo';

/** One received message: its id and the receipt handle of this receive. */
export interface ReceivedDlqMessage {
  readonly message_id: string;
  readonly receipt_handle: string;
}

/** What one receive found: messages, a queue that no longer exists, or a failure. */
export type DlqReceive =
  | { readonly kind: 'messages'; readonly messages: readonly ReceivedDlqMessage[] }
  | { readonly kind: 'queue_absent' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

/** The outcome of deleting or releasing one received message. */
export type DlqMessageChange =
  { readonly kind: 'done' } | { readonly kind: 'failed'; readonly reason: StructuredReason };

/** The three SQS calls the sweep makes (`aws/sqs-dlq-message-queue.ts` in production). */
export interface DlqQueueAccess {
  receive(queueUrl: string): Promise<DlqReceive>;
  deleteMessage(queueUrl: string, receiptHandle: string): Promise<DlqMessageChange>;
  releaseMessage(queueUrl: string, receiptHandle: string): Promise<DlqMessageChange>;
}

interface SweepState {
  readonly captured: ReadonlySet<string>;
  readonly pending: Set<string>;
  readonly deleted: string[];
  readonly failed: { readonly message_id: string; readonly reason: StructuredReason }[];
}

/**
 * The production `DlqMessagePort`: deletes exactly the captured messages from the execution's
 * DLQs (the resource-manifest outputs), never an uncaptured one.
 *
 * @example
 * const port = new CapturedDlqMessageDeletion(new SqsDlqMessageQueue(sqs), targets.dlq_urls);
 * await port.deleteCaptured(['m-1']); // { deleted: ['m-1'], absent: [], failed: [] }
 */
export class CapturedDlqMessageDeletion implements DlqMessagePort {
  readonly #queue: DlqQueueAccess;
  readonly #queueUrls: readonly string[];

  constructor(queue: DlqQueueAccess, queueUrls: readonly string[]) {
    this.#queue = queue;
    this.#queueUrls = [...new Set(queueUrls)];
  }

  /** Sweeps every bound DLQ for the captured ids; never throws on a queue failure. */
  async deleteCaptured(messageIds: readonly string[]): Promise<DlqDeletionReport> {
    const state: SweepState = { captured: new Set(messageIds), pending: new Set(messageIds), deleted: [], failed: [] };
    const gaps: StructuredReason[] = this.#queueUrls.length === 0 ? [unboundReason()] : [];
    for (const queueUrl of this.#queueUrls) {
      const gap = state.pending.size === 0 ? undefined : await this.#sweep(queueUrl, state);
      gaps.push(...(gap === undefined ? [] : [gap]));
    }
    const remaining = [...state.pending].sort();
    const [firstGap] = gaps;
    if (firstGap === undefined) {
      return { deleted: state.deleted, absent: remaining, failed: state.failed };
    }
    const unproven = remaining.map((messageId) => ({
      message_id: messageId,
      reason: unprovenReason(messageId, firstGap),
    }));
    return { deleted: state.deleted, absent: [], failed: [...state.failed, ...unproven] };
  }

  // Why this queue's sweep proves nothing about the ids still pending, or undefined when it ended
  // in an empty receive with nothing hiding a group (or found the queue gone, or found every id).
  async #sweep(queueUrl: string, state: SweepState): Promise<StructuredReason | undefined> {
    const held: ReceivedDlqMessage[] = [];
    const gap = await this.#receiveUntilEmpty(queueUrl, state, held);
    for (const message of held) {
      await this.#queue.releaseMessage(queueUrl, message.receipt_handle);
    }
    if (gap !== undefined || held.length === 0 || !queueUrl.endsWith(FIFO_QUEUE_SUFFIX)) {
      return gap;
    }
    return {
      code: 'DLQ_FIFO_GROUP_HIDDEN',
      subject: queueUrl,
      detail: `the sweep held ${String(held.length)} message(s) of a FIFO queue, which hides the rest of their groups; expected an empty receive with no message held`,
    };
  }

  async #receiveUntilEmpty(
    queueUrl: string,
    state: SweepState,
    held: ReceivedDlqMessage[],
  ): Promise<StructuredReason | undefined> {
    for (let receives = 0; receives < MAX_DLQ_RECEIVES_PER_QUEUE; receives += 1) {
      const received = await this.#queue.receive(queueUrl);
      if (received.kind !== 'messages' || received.messages.length === 0) {
        return received.kind === 'failed' ? received.reason : undefined;
      }
      for (const message of received.messages) {
        await this.#settleMessage(queueUrl, message, state, held);
      }
      if (state.pending.size === 0) {
        return undefined;
      }
    }
    return {
      code: 'DLQ_SWEEP_INCOMPLETE',
      subject: queueUrl,
      detail: `${String(MAX_DLQ_RECEIVES_PER_QUEUE)} receives never came back empty; expected the queue to drain of visible messages`,
    };
  }

  // Deletes a captured message; holds any other message, and a captured one that failed to delete.
  async #settleMessage(
    queueUrl: string,
    message: ReceivedDlqMessage,
    state: SweepState,
    held: ReceivedDlqMessage[],
  ): Promise<void> {
    const { message_id: messageId } = message;
    const deletion = state.captured.has(messageId)
      ? await this.#queue.deleteMessage(queueUrl, message.receipt_handle)
      : undefined;
    const wasPending = state.pending.delete(messageId);
    if (deletion?.kind === 'done') {
      state.deleted.push(...(wasPending ? [messageId] : []));
      return;
    }
    held.push(message);
    if (deletion !== undefined && wasPending) {
      state.failed.push({ message_id: messageId, reason: deletion.reason });
    }
  }
}

function unprovenReason(messageId: string, gap: StructuredReason): StructuredReason {
  return {
    code: 'DLQ_MESSAGE_NOT_PROVEN_ABSENT',
    subject: messageId,
    detail: `captured message not received, and the sweep proved nothing (${gap.code} on ${boundedText(gap.subject)}: ${boundedText(gap.detail)}); expected a sweep ending in an empty receive`,
  };
}

function unboundReason(): StructuredReason {
  return {
    code: 'DLQ_QUEUES_UNBOUND',
    subject: 'BR-RUA-048',
    detail: 'no dead-letter queue is bound to the deletion; expected the DLQ URLs of the resource manifest outputs',
  };
}
