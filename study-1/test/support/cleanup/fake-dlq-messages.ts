// The offline run-owned dead-letter queues (BR-RUA-048 steps 7-8): messages by id. It records
// every id cleanup asked to delete, so a test can prove an uncaptured message is never deleted.

import type { DlqDeletionReport, DlqMessagePort } from '../../../src/cleanup/cleanup-ports.ts';
import type { RecordingMutationLog } from '../kernel/recording-mutation-log.ts';

/**
 * Dead-letter messages that cleanup may delete by id.
 *
 * @example
 * const dlq = new FakeDlqMessages(log);
 * dlq.add('m-1', 'm-2');
 * await dlq.deleteCaptured(['m-1', 'm-9']); // { deleted: ['m-1'], absent: ['m-9'], failed: [] }
 */
export class FakeDlqMessages implements DlqMessagePort {
  readonly #log: RecordingMutationLog;
  readonly #messages = new Set<string>();
  readonly #failing = new Set<string>();
  readonly #requested: string[] = [];

  constructor(log: RecordingMutationLog) {
    this.#log = log;
  }

  add(...messageIds: readonly string[]): void {
    for (const messageId of messageIds) {
      this.#messages.add(messageId);
    }
  }

  /** Deleting this message fails. */
  failDelete(messageId: string): void {
    this.#failing.add(messageId);
  }

  /** The messages still in the queues, sorted. */
  remaining(): readonly string[] {
    return [...this.#messages].sort();
  }

  /** Every id cleanup asked to delete, in call order. */
  requested(): readonly string[] {
    return [...this.#requested];
  }

  deleteCaptured(messageIds: readonly string[]): Promise<DlqDeletionReport> {
    const deleted: string[] = [];
    const absent: string[] = [];
    const failed: DlqDeletionReport['failed'][number][] = [];
    for (const messageId of messageIds) {
      this.#requested.push(messageId);
      this.#log.record({ port: 'sqs', operation: 'DeleteMessage', target: messageId });
      if (this.#failing.has(messageId)) {
        failed.push({
          message_id: messageId,
          reason: {
            code: 'ReceiptHandleIsInvalid',
            subject: messageId,
            detail: 'scripted deletion failure; expected deleted',
          },
        });
        continue;
      }
      (this.#messages.delete(messageId) ? deleted : absent).push(messageId);
    }
    return Promise.resolve({ deleted, absent, failed });
  }
}
