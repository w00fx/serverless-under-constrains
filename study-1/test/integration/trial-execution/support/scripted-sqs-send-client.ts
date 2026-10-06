// A real SQSClient, built by the collector's production factory, over a scripted HTTP layer that
// answers `SendMessage` (design §12.2; SQS API reference SendMessage). The SDK's own awsJson1_0
// serializer, signer, MD5-of-body middleware, retry middleware and error deserializer run; only
// the network is replaced. Each request is answered by the next script, in order:
// - `accept`: HTTP 200 with a MessageId, a SequenceNumber and the body's MD5 (or the given one);
// - `accept_without`: HTTP 200 whose output lacks the named members;
// - `error`: an SQS error type with its HTTP status (`__type` `com.amazonaws.sqs#<Type>`);
// - `network_error`: the handler rejects, as a reset socket does.
// Every request is recorded with its decoded input, so tests assert the wire request.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { SQSClient } from '@aws-sdk/client-sqs';
import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createCollectorSqsClient } from '../../../../src/evidence-collection/aws/sqs-collector.ts';
import type { JsonObject } from '../../../../src/record-contract/primitives.ts';

export type ScriptedSend =
  | { readonly kind: 'accept'; readonly md5?: string }
  | { readonly kind: 'accept_without'; readonly members: readonly string[] }
  | { readonly kind: 'error'; readonly type: string; readonly status: number }
  | { readonly kind: 'network_error'; readonly error: Error };

export interface RecordedSqsRequest {
  readonly target: string;
  readonly content_type: string;
  readonly input: JsonObject;
}

const SQS_TARGET_PREFIX = 'AmazonSQS.';

export class ScriptedSqsSendClient {
  readonly client: SQSClient;
  readonly #scripts: ScriptedSend[] = [];
  readonly #requests: RecordedSqsRequest[] = [];
  #sequence = 0;

  constructor() {
    this.client = createCollectorSqsClient({
      credentials: { accessKeyId: 'AKIDSCRIPTEDSEND', secretAccessKey: 'scripted-send-not-a-secret' },
      requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
    });
  }

  /** Queues the answer to the next request. */
  script(send: ScriptedSend): void {
    this.#scripts.push(send);
  }

  /** Every request the client sent, in order. */
  requests(): readonly RecordedSqsRequest[] {
    return [...this.#requests];
  }

  #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const input = JSON.parse(bodyText(request.body)) as JsonObject;
    this.#requests.push({
      target: request.headers['x-amz-target'] ?? '',
      content_type: request.headers['content-type'] ?? '',
      input,
    });
    const script = this.#scripts.shift();
    if (script === undefined) {
      return Promise.reject(
        new Error(`no scripted answer for ${JSON.stringify(input['QueueUrl'] ?? null)}; expected script(...) first`),
      );
    }
    if (script.kind === 'network_error') {
      return Promise.reject(script.error);
    }
    if (script.kind === 'error') {
      return respond(script.status, { __type: `com.amazonaws.sqs#${script.type}`, message: `scripted ${script.type}` });
    }
    this.#sequence += 1;
    const body = typeof input['MessageBody'] === 'string' ? input['MessageBody'] : '';
    const output: Record<string, string> = {
      MessageId: `scripted-message-${String(this.#sequence)}`,
      SequenceNumber: `1000000000000000000${String(this.#sequence)}`,
      MD5OfMessageBody: createHash('md5').update(body, 'utf8').digest('hex'),
    };
    if (script.kind === 'accept') {
      return respond(200, script.md5 === undefined ? output : { ...output, MD5OfMessageBody: script.md5 });
    }
    return respond(200, Object.fromEntries(Object.entries(output).filter(([name]) => !script.members.includes(name))));
  }
}

/** The SQS operation of a recorded request, from its `X-Amz-Target`. */
export function operationOf(request: RecordedSqsRequest): string {
  return request.target.startsWith(SQS_TARGET_PREFIX) ? request.target.slice(SQS_TARGET_PREFIX.length) : request.target;
}

function respond(status: number, body: JsonObject): Promise<{ response: HttpResponse }> {
  return Promise.resolve({
    response: {
      statusCode: status,
      headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amzn-requestid': 'scripted-sqs-request' },
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
