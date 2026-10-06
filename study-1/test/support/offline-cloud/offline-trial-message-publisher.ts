// Offline stand-in for SQS `SendMessage` of the trial message (design §5.3 `TrialMessagePublisher`,
// §12.2): the body goes onto the in-memory FIFO source with its group and deduplication ids, and the
// send returns the message id, FIFO sequence number and body MD5 that SQS returns.
//
// Test hooks, outside the port:
// - `tamperNextBody(rewrite)` replaces the body of the next send, so the consumer receives a
//   message the runner did not publish (AC-RUA-019: wrong execution identity or manifest digest);
// - `failNext(outcome)` makes the next send return `rejected` or `ambiguous` without sending
//   (`ambiguous` sends it anyway: the message may be on the queue, which is what ambiguous means).

import type {
  TrialMessagePublisher,
  TrialMessageSend,
  TrialMessageSendOutcome,
} from '../../../src/trial-execution/trial-execution-ports.ts';
import type { InMemoryFifoQueue } from '../fifo-queue/in-memory-fifo-queue.ts';
import type { OfflineMessageLog } from './offline-message-log.ts';

type ScriptedSendFailure = Extract<TrialMessageSendOutcome, { readonly kind: 'rejected' | 'ambiguous' }>;

export class OfflineTrialMessagePublisher implements TrialMessagePublisher {
  readonly #queues: ReadonlyMap<string, InMemoryFifoQueue>;
  readonly #log: OfflineMessageLog;
  readonly #sends: TrialMessageSend[] = [];
  #rewrite: ((body: string) => string) | undefined;
  #failure: ScriptedSendFailure | undefined;

  /** `queues` maps each queue URL to the queue it names. */
  constructor(queues: ReadonlyMap<string, InMemoryFifoQueue>, log: OfflineMessageLog) {
    this.#queues = queues;
    this.#log = log;
  }

  publish(send: TrialMessageSend): Promise<TrialMessageSendOutcome> {
    this.#sends.push(send);
    const queue = this.#queues.get(send.queue_url);
    if (queue === undefined) {
      return Promise.resolve({ kind: 'rejected', code: 'AWS.SimpleQueueService.NonExistentQueue' });
    }
    const failure = this.#failure;
    this.#failure = undefined;
    if (failure?.kind === 'rejected') {
      return Promise.resolve(failure);
    }
    const rewrite = this.#rewrite;
    this.#rewrite = undefined;
    const body = rewrite === undefined ? send.body : rewrite(send.body);
    const logged = this.#log.send(queue, {
      body,
      message_group_id: send.message_group_id,
      message_deduplication_id: send.message_deduplication_id,
    });
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    return Promise.resolve({
      kind: 'sent',
      message_id: logged.message_id,
      sequence_number: logged.sequence_number,
      md5_of_message_body: logged.md5_of_body,
    });
  }

  /** The next send puts `rewrite(body)` on the queue instead of the published body. */
  tamperNextBody(rewrite: (body: string) => string): void {
    this.#rewrite = rewrite;
  }

  /** The next send returns `failure`; an ambiguous one still reaches the queue. */
  failNext(failure: ScriptedSendFailure): void {
    this.#failure = failure;
  }

  /** Every send the runner asked for, in order. */
  sends(): readonly TrialMessageSend[] {
    return [...this.#sends];
  }
}
