// A named fake of the collector's `DlqReceiver` port (design §5.3 `DlqCapturePort`, §12.2): a FIFO
// dead-letter queue received with a zero visibility timeout. Messages are never deleted, so every
// receive returns the same head messages again, at most 10 per batch, each receive counting toward
// the message's `ApproximateReceiveCount` as SQS does. Raw entries are kept as given, so a test can
// put a malformed or hostile message on the queue. In `rotating` mode each receive returns the next
// window of the queue instead (messages of other groups becoming visible in turn), which is how a
// queue keeps yielding unseen messages round after round.

import type { Result } from '../../../src/record-contract/primitives.ts';
import type { CollectorReadFailure } from '../../../src/evidence-collection/collected-records.ts';
import type { DlqReceiver, ReceivedSqsMessage } from '../../../src/evidence-collection/dlq-capture.ts';

/** The SQS ReceiveMessage limit. */
export const DLQ_BATCH_LIMIT = 10;

/**
 * A FIFO DLQ that only ever receives, with one-shot failures.
 *
 * @example
 * const dlq = new ScriptedDlqReceiver();
 * dlq.enqueue(sqsMessage({ group: trialId }));
 * await dlq.receiveBatch(dlqUrl); // { ok: true, value: [message] }, and again on the next call
 */
export class ScriptedDlqReceiver implements DlqReceiver {
  readonly #messages: ReceivedSqsMessage[] = [];
  readonly #failures = new Map<number, string>();
  readonly #mode: 'head' | 'rotating';
  #receives = 0;

  constructor(mode: 'head' | 'rotating' = 'head') {
    this.#mode = mode;
  }

  /** Puts a message at the tail of the queue. */
  enqueue(message: ReceivedSqsMessage): void {
    this.#messages.push(message);
  }

  /** Receive number `onReceive` (the next one by default, counting from 1) fails with `code`. */
  scriptFailure(code: string, onReceive: number = this.#receives + 1): void {
    this.#failures.set(onReceive, code);
  }

  /** How many receive calls were made. */
  receiveCount(): number {
    return this.#receives;
  }

  receiveBatch(_queueUrl: string): Promise<Result<readonly ReceivedSqsMessage[], CollectorReadFailure>> {
    this.#receives += 1;
    const code = this.#failures.get(this.#receives);
    if (code !== undefined) {
      return Promise.resolve({ ok: false, error: { code } });
    }
    const start =
      this.#mode === 'head' ? 0 : ((this.#receives - 1) * DLQ_BATCH_LIMIT) % Math.max(this.#messages.length, 1);
    const batch = this.#messages.slice(start, start + DLQ_BATCH_LIMIT).map((message) => withOneMoreReceive(message));
    batch.forEach((message, index) => {
      this.#messages[start + index] = message;
    });
    return Promise.resolve({ ok: true, value: batch });
  }
}

// SQS counts every receive; a message whose attributes are not a plain map is returned unchanged.
function withOneMoreReceive(message: ReceivedSqsMessage): ReceivedSqsMessage {
  const attributes = message.Attributes;
  if (typeof attributes !== 'object' || attributes === null || !Object.hasOwn(attributes, 'ApproximateReceiveCount')) {
    return message;
  }
  const count = Number((attributes as Readonly<Record<string, unknown>>)['ApproximateReceiveCount']);
  if (!Number.isSafeInteger(count)) {
    return message;
  }
  return { ...message, Attributes: { ...attributes, ApproximateReceiveCount: String(count + 1) } };
}
