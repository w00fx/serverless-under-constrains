// A real SQSClient, built by the collector's production factory, over a scripted HTTP layer (design
// §12.2 `ScriptedSqsClient`). The SDK's own awsJson1_0 serializer, signer, MD5-of-body check and
// error deserializer run; only the network is replaced by a model of queues: each URL has its
// attribute map (the approximate counters) and its messages, which ReceiveMessage returns without
// deleting, at most 10, counting one more receive on each. Every call is recorded with its decoded
// input, so tests assert the wire request (VisibilityTimeout 0, every system attribute).

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { SQSClient } from '@aws-sdk/client-sqs';
import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createCollectorSqsClient } from '../../../src/evidence-collection/aws/sqs-collector.ts';
import type { CollectorSqsClientSettings } from '../../../src/evidence-collection/aws/sqs-collector.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';

export const SQS_TARGET_PREFIX = 'AmazonSQS.';

/** One queued message on the wire; MD5OfBody is computed from the body unless given. */
export interface WireSqsMessage {
  readonly MessageId: string;
  readonly Body: string;
  readonly MD5OfBody?: string;
  readonly Attributes: Readonly<Record<string, string>>;
}

export interface RecordedSqsCall {
  readonly operation: string;
  readonly input: JsonValue;
}

interface QueueModel {
  attributes: Readonly<Record<string, string>>;
  readonly messages: WireSqsMessage[];
}

/**
 * Production-built SQS client over a queue model.
 *
 * @example
 * const sqs = new ScriptedSqsClient();
 * sqs.setQueueAttributes(dlqUrl, { ApproximateNumberOfMessages: '1', … });
 * sqs.enqueueMessage(dlqUrl, { MessageId: 'm1', Body: body, Attributes: { MessageGroupId: trialId, … } });
 * await createSqsDlqReceiver(sqs.client).receiveBatch(dlqUrl);
 */
export class ScriptedSqsClient {
  readonly client: SQSClient;
  readonly #queues = new Map<string, QueueModel>();
  readonly #errors: { readonly type: string; readonly status: number }[] = [];
  readonly #calls: RecordedSqsCall[] = [];

  constructor(settings: CollectorSqsClientSettings = {}) {
    this.client = createCollectorSqsClient({
      ...settings,
      credentials: { accessKeyId: 'AKIDSCRIPTEDSQS', secretAccessKey: 'scripted-sqs-not-a-secret' },
      requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
    });
  }

  setQueueAttributes(queueUrl: string, attributes: Readonly<Record<string, string>>): void {
    this.#queue(queueUrl).attributes = { ...attributes };
  }

  enqueueMessage(queueUrl: string, message: WireSqsMessage): void {
    this.#queue(queueUrl).messages.push(message);
  }

  /** The next request fails with this SQS error type (HTTP 400 unless `status` says otherwise). */
  scriptError(type: string, status = 400): void {
    this.#errors.push({ type, status });
  }

  calls(): readonly RecordedSqsCall[] {
    return [...this.#calls];
  }

  #queue(queueUrl: string): QueueModel {
    const existing = this.#queues.get(queueUrl);
    if (existing !== undefined) {
      return existing;
    }
    const created: QueueModel = { attributes: {}, messages: [] };
    this.#queues.set(queueUrl, created);
    return created;
  }

  #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const target = request.headers['x-amz-target'] ?? '';
    const operation = target.startsWith(SQS_TARGET_PREFIX) ? target.slice(SQS_TARGET_PREFIX.length) : target;
    const input = JSON.parse(bodyText(request.body)) as JsonObject;
    this.#calls.push({ operation, input });
    const error = this.#errors.shift();
    if (error !== undefined) {
      return respond(error.status, { __type: `com.amazonaws.sqs#${error.type}`, message: `scripted ${error.type}` });
    }
    const queueUrl = typeof input['QueueUrl'] === 'string' ? input['QueueUrl'] : '';
    const queue = this.#queues.get(queueUrl);
    if (queue === undefined) {
      return respond(400, { __type: 'com.amazonaws.sqs#QueueDoesNotExist', message: `no queue ${queueUrl}` });
    }
    if (operation === 'GetQueueAttributes') {
      return respond(200, { Attributes: { ...queue.attributes } });
    }
    if (operation === 'ReceiveMessage') {
      // An empty receive carries no Messages member at all, as SQS answers it.
      const messages = receive(queue);
      return respond(200, messages.length === 0 ? {} : { Messages: messages });
    }
    return respond(400, { __type: 'com.amazonaws.sqs#UnsupportedOperation', message: operation });
  }
}

// Receive without delete: the head messages again, each with one more receive counted.
function receive(queue: QueueModel): JsonObject[] {
  const batch = queue.messages.slice(0, 10).map((message) => ({
    ...message,
    Attributes: {
      ...message.Attributes,
      ApproximateReceiveCount: String(Number(message.Attributes['ApproximateReceiveCount'] ?? '0') + 1),
    },
  }));
  batch.forEach((message, index) => {
    queue.messages[index] = message;
  });
  return batch.map((message) => ({
    MessageId: message.MessageId,
    ReceiptHandle: `receipt-${message.MessageId}`,
    Body: message.Body,
    MD5OfBody: message.MD5OfBody ?? createHash('md5').update(message.Body, 'utf8').digest('hex'),
    Attributes: message.Attributes,
  }));
}

function respond(status: number, body: JsonObject): Promise<{ response: HttpResponse }> {
  return Promise.resolve({
    response: {
      statusCode: status,
      headers: { 'content-type': 'application/x-amz-json-1.0' },
      body: Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]),
    },
  });
}

function bodyText(body: unknown): string {
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  throw new TypeError(`request body is ${typeof body}; expected the SDK's Uint8Array JSON body`);
}
