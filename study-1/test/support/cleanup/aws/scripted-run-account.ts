// ScriptedRunAccount: the AWS account of one live run behind the real cleanup clients, answering
// cleanup's mutations as AWS does, so the orchestrator can run over the AWS-bound ports:
// - `UpdateEventSourceMapping(Enabled=false)` disables the source mapping;
// - `StopDurableExecution` ends the running durable execution;
// - `DeleteStack` deletes the stack and everything it manages, unless a durable execution still
//   runs: the stack then ends `DELETE_FAILED` with every member in place (RK-10);
// - `ReceiveMessage` of the DLQ answers the messages queued with `enqueueDlqMessage`, then empty;
//   `DeleteMessage` removes one by its receipt handle, `ChangeMessageVisibility` releases one.
// Reads are scripted by `scriptLiveRun`. Every request is recorded by the endpoint.

import { EXECUTION_ID, NAMES, STACK_ID, STACK_NAME } from '../cleanup-fixtures.ts';
import { scriptLiveRun } from './live-run-script.ts';
import type { LiveResource } from './live-run-script.ts';
import { refuse, reply, ScriptedCleanupEndpoint, sqsMessage } from './scripted-cleanup-endpoint.ts';

const STACK_MEMBERS: readonly LiveResource[] = ['functions', 'mapping', 'queue', 'table', 'log_group', 'role'];

/**
 * One live run's account over a scripted endpoint.
 *
 * @example
 * const account = new ScriptedRunAccount();
 * const ports = bindAwsCleanupPorts(account.endpoint.clients, targets);
 */
export class ScriptedRunAccount {
  readonly endpoint = new ScriptedCleanupEndpoint();
  readonly #gone = new Set<LiveResource>();
  readonly #dlq: { readonly id: string; hidden_by?: string }[] = [];
  #mappingState = 'Enabled';
  #stackStatus: 'CREATE_COMPLETE' | 'DELETE_FAILED' = 'CREATE_COMPLETE';
  #receipts = 0;

  constructor() {
    scriptLiveRun(this.endpoint, { gone: this.#gone, mappingState: () => this.#mappingState });
    this.endpoint.respond('lambda:UpdateEventSourceMapping', () => {
      if (this.#gone.has('mapping')) {
        return refuse('ResourceNotFoundException', 'no mapping', 404);
      }
      this.#mappingState = 'Disabled';
      return reply({ UUID: NAMES.sourceMapping, State: 'Disabling' });
    });
    this.endpoint.respond('lambda:StopDurableExecution', () => {
      this.#gone.add('execution');
      return reply({});
    });
    this.endpoint.respond('cloudformation:DeleteStack', () => this.#deleteStack());
    this.#scriptStackStatus();
    this.#scriptDlq();
  }

  /** Queues a message in the durable DLQ. */
  enqueueDlqMessage(messageId: string): void {
    this.#dlq.push({ id: messageId });
  }

  /** The ids still in the durable DLQ. */
  dlqMessageIds(): readonly string[] {
    return this.#dlq.map((message) => message.id);
  }

  /** Whether the stack and its members are gone. */
  stackDeleted(): boolean {
    return this.#gone.has('stack');
  }

  #deleteStack(): ReturnType<typeof reply> {
    if (this.#gone.has('execution')) {
      for (const resource of ['stack', ...STACK_MEMBERS] as const) {
        this.#gone.add(resource);
      }
    } else {
      this.#stackStatus = 'DELETE_FAILED';
    }
    return reply('');
  }

  // A failed deletion leaves the stack listed in DELETE_FAILED rather than CREATE_COMPLETE.
  #scriptStackStatus(): void {
    this.endpoint.respond('cloudformation:DescribeStacks', () => {
      if (this.#gone.has('stack')) {
        return refuse('ValidationError', `Stack with id ${STACK_ID} does not exist`);
      }
      return reply(
        `<Stacks><member><StackId>${STACK_ID}</StackId><StackName>${STACK_NAME}</StackName>` +
          `<Tags><member><Key>suc:run_id</Key><Value>${EXECUTION_ID}</Value></member></Tags>` +
          `<CreationTime>2026-10-05T11:30:00.000Z</CreationTime><StackStatus>${this.#stackStatus}</StackStatus></member></Stacks>`,
      );
    });
  }

  #scriptDlq(): void {
    this.endpoint.respond('sqs:ReceiveMessage', () => {
      if (this.#gone.has('queue')) {
        return refuse('QueueDoesNotExist');
      }
      const visible = this.#dlq.filter((message) => message.hidden_by === undefined).slice(0, 10);
      const messages = visible.map((message) => {
        this.#receipts += 1;
        message.hidden_by = `receipt-${String(this.#receipts)}`;
        return sqsMessage(message.id, message.hidden_by);
      });
      return reply(messages.length === 0 ? {} : { Messages: messages });
    });
    this.endpoint.respond('sqs:DeleteMessage', (call) => {
      const index = this.#dlq.findIndex((message) => message.hidden_by === call.input['ReceiptHandle']);
      this.#dlq.splice(index, index === -1 ? 0 : 1);
      return reply({});
    });
    this.endpoint.respond('sqs:ChangeMessageVisibility', (call) => {
      const held = this.#dlq.find((message) => message.hidden_by === call.input['ReceiptHandle']);
      if (held !== undefined) {
        delete held.hidden_by;
      }
      return reply({});
    });
  }
}
