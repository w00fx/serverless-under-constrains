// ScriptedCleanupEndpoint (design §12.2): the HTTP layer under the seven clients that
// `createCleanupAwsClients` builds. The SDK's own serializers, signer and deserializers run; only
// the network is replaced by scripted answers in each service's wire protocol: CloudFormation
// and IAM answer awsQuery XML, SQS and DynamoDB awsJson1_0, CloudWatch Logs and the Tagging API
// awsJson1_1, Lambda REST-JSON. Each request is decoded into its operation and input (JSON body,
// query form, or REST path labels plus query string) and recorded, so a test proves what the
// adapters sent, once each, to `us-east-1`, with no network and no real credentials.
//
// Answers are scripted per `service:Operation`: a queue of replies (the last one repeats) or a
// responder over the decoded call. An operation with no script answers HTTP 500.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createCleanupAwsClients } from '../../../../src/cleanup/aws/cleanup-aws-clients.ts';
import type { CleanupAwsClients, CleanupClientSettings } from '../../../../src/cleanup/aws/cleanup-aws-clients.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';

export interface RecordedCleanupCall {
  readonly service: string;
  readonly operation: string;
  readonly region: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** A failure the endpoint answers with, in the service's error format. */
export interface ScriptedServiceError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** One reply: a body (JSON, or the inner XML of a query `Result`) or a service error. */
export type ScriptedReply =
  | { readonly kind: 'body'; readonly body: JsonValue | string }
  | { readonly kind: 'error'; readonly error: ScriptedServiceError };

type Responder = (call: RecordedCleanupCall) => ScriptedReply;

interface WireAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const REGION_LABEL = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const QUERY_NAMESPACES: Readonly<Record<string, string>> = {
  cloudformation: 'http://cloudformation.amazonaws.com/doc/2010-05-15/',
  iam: 'https://iam.amazonaws.com/doc/2010-05-08/',
};
const JSON_CONTENT_TYPES: Readonly<Record<string, string>> = {
  sqs: 'application/x-amz-json-1.0',
  dynamodb: 'application/x-amz-json-1.0',
  logs: 'application/x-amz-json-1.1',
  tagging: 'application/x-amz-json-1.1',
};

// Lambda REST routes: method, raw path pattern, operation, and the path labels it captures.
const LAMBDA_ROUTES: readonly (readonly [string, RegExp, string, readonly string[]])[] = [
  ['PUT', /^\/2015-03-31\/event-source-mappings\/([^/]+)$/, 'UpdateEventSourceMapping', ['UUID']],
  ['GET', /^\/2015-03-31\/event-source-mappings\/([^/]+)$/, 'GetEventSourceMapping', ['UUID']],
  ['DELETE', /^\/2015-03-31\/event-source-mappings\/([^/]+)$/, 'DeleteEventSourceMapping', ['UUID']],
  ['GET', /^\/2015-03-31\/event-source-mappings\/?$/, 'ListEventSourceMappings', []],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)\/versions$/, 'ListVersionsByFunction', ['FunctionName']],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)\/aliases$/, 'ListAliases', ['FunctionName']],
  ['DELETE', /^\/2015-03-31\/functions\/([^/]+)\/aliases\/([^/]+)$/, 'DeleteAlias', ['FunctionName', 'Name']],
  ['GET', /^\/2015-03-31\/functions\/([^/]+)$/, 'GetFunction', ['FunctionName']],
  ['DELETE', /^\/2015-03-31\/functions\/([^/]+)$/, 'DeleteFunction', ['FunctionName']],
  ['GET', /^\/2017-03-31\/tags\/([^/]+)$/, 'ListTags', ['Resource']],
  [
    'GET',
    /^\/2025-12-01\/functions\/([^/]+)\/durable-executions$/,
    'ListDurableExecutionsByFunction',
    ['FunctionName'],
  ],
  ['POST', /^\/2025-12-01\/durable-executions\/([^/]+)\/stop$/, 'StopDurableExecution', ['DurableExecutionArn']],
  ['GET', /^\/2025-12-01\/durable-executions\/([^/]+)$/, 'GetDurableExecution', ['DurableExecutionArn']],
];

/** A body reply: JSON, or the inner XML of a CloudFormation or IAM `Result`. */
export function reply(body: JsonValue | string = {}): ScriptedReply {
  return { kind: 'body', body };
}

/** A service-error reply. */
export function refuse(code: string, message = `scripted ${code}`, status = 400): ScriptedReply {
  return { kind: 'error', error: { status, code, message } };
}

/** An SQS `ReceiveMessage` entry with a body and its true MD5, as SQS answers it. */
export function sqsMessage(messageId: string, receiptHandle: string, body = '{}'): JsonValue {
  return {
    MessageId: messageId,
    ReceiptHandle: receiptHandle,
    Body: body,
    MD5OfBody: createHash('md5').update(body, 'utf8').digest('hex'),
  };
}

/**
 * The scripted endpoint and the production clients over it.
 *
 * @example
 * const endpoint = new ScriptedCleanupEndpoint();
 * endpoint.answer('lambda:GetEventSourceMapping', reply({ UUID: uuid, State: 'Disabled' }));
 * await new LambdaConsumerControl(endpoint.clients.lambda).readState(uuid);
 */
export class ScriptedCleanupEndpoint {
  readonly clients: CleanupAwsClients;
  readonly #queues = new Map<string, ScriptedReply[]>();
  readonly #responders = new Map<string, Responder>();
  readonly #calls: RecordedCleanupCall[] = [];

  constructor(settings: CleanupClientSettings = {}) {
    this.clients = createCleanupAwsClients({
      credentials: { accessKeyId: 'AKIDSCRIPTEDCLEANUP', secretAccessKey: 'scripted-cleanup-not-a-secret' },
      requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
      ...settings,
    });
  }

  /** `service:Operation` answers these replies in order; the last one repeats. */
  answer(operation: string, ...replies: readonly ScriptedReply[]): void {
    this.#responders.delete(operation);
    this.#queues.set(operation, [...replies]);
  }

  /** `service:Operation` answers what the responder makes of each decoded call. */
  respond(operation: string, responder: Responder): void {
    this.#queues.delete(operation);
    this.#responders.set(operation, responder);
  }

  /** Every call so far, in order, or only those of one `service:Operation`. */
  calls(operation?: string): readonly RecordedCleanupCall[] {
    return this.#calls.filter((call) => operation === undefined || `${call.service}:${call.operation}` === operation);
  }

  /** The `service:Operation` of every call so far, in order. */
  operations(): readonly string[] {
    return this.#calls.map((call) => `${call.service}:${call.operation}`);
  }

  async #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const service = serviceOf(request.hostname);
    const region = request.hostname.split('.').find((label) => REGION_LABEL.test(label)) ?? '';
    const decoded = decodeRequest(service, request, await bodyText(request.body));
    const call: RecordedCleanupCall = { service, region, ...decoded };
    this.#calls.push(call);
    const wire = wireAnswer(service, call.operation, this.#replyTo(call));
    return {
      response: {
        statusCode: wire.status,
        headers: { 'content-type': wire.contentType, 'x-amzn-requestid': 'scripted', ...wire.headers },
        body: Readable.from([Buffer.from(wire.body, 'utf8')]),
      },
    };
  }

  #replyTo(call: RecordedCleanupCall): ScriptedReply | undefined {
    const key = `${call.service}:${call.operation}`;
    const responder = this.#responders.get(key);
    if (responder !== undefined) {
      return responder(call);
    }
    const queue = this.#queues.get(key);
    return queue !== undefined && queue.length > 1 ? queue.shift() : queue?.[0];
  }
}

// DynamoDB addresses an ARN-named resource at its account endpoint `<account>.ddb.<region>.amazonaws.com`.
function serviceOf(hostname: string): string {
  const labels = hostname.split('.');
  return labels.includes('ddb') ? 'dynamodb' : (labels[0] ?? '');
}

function decodeRequest(
  service: string,
  request: HttpRequest,
  body: string,
): { readonly operation: string; readonly input: Readonly<Record<string, unknown>> } {
  if (service === 'cloudformation' || service === 'iam') {
    const form = new URLSearchParams(body);
    return { operation: form.get('Action') ?? '', input: Object.fromEntries(form) };
  }
  if (service === 'lambda') {
    return decodeLambda(request, body);
  }
  const target = request.headers['x-amz-target'] ?? '';
  return {
    operation: target.slice(target.indexOf('.') + 1),
    input: body === '' ? {} : (JSON.parse(body) as Record<string, unknown>),
  };
}

function decodeLambda(
  request: HttpRequest,
  body: string,
): { readonly operation: string; readonly input: Readonly<Record<string, unknown>> } {
  const query = Object.fromEntries(Object.entries(request.query ?? {}).map(([key, value]) => [key, value]));
  const jsonBody = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>);
  for (const [method, pattern, operation, labels] of LAMBDA_ROUTES) {
    const match = request.method === method ? pattern.exec(request.path) : null;
    if (match !== null) {
      const path = Object.fromEntries(
        labels.map((label, index) => [label, decodeURIComponent(match[index + 1] ?? '')]),
      );
      return { operation, input: { ...query, ...jsonBody, ...path } };
    }
  }
  return { operation: `${request.method} ${request.path}`, input: { ...query, ...jsonBody } };
}

function wireAnswer(service: string, operation: string, scripted: ScriptedReply | undefined): WireAnswer {
  if (scripted === undefined) {
    return { status: 500, contentType: 'text/plain', body: `no scripted answer for ${service}:${operation}` };
  }
  if (scripted.kind === 'error') {
    return errorAnswer(service, scripted.error);
  }
  const { body } = scripted;
  if (service === 'cloudformation' || service === 'iam') {
    const namespace = QUERY_NAMESPACES[service] ?? '';
    const result = typeof body === 'string' ? body : '';
    return {
      status: 200,
      contentType: 'text/xml',
      body:
        `<${operation}Response xmlns="${namespace}"><${operation}Result>${result}</${operation}Result>` +
        `<ResponseMetadata><RequestId>scripted</RequestId></ResponseMetadata></${operation}Response>`,
    };
  }
  return {
    status: 200,
    contentType: JSON_CONTENT_TYPES[service] ?? 'application/json',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function errorAnswer(service: string, error: ScriptedServiceError): WireAnswer {
  if (service === 'cloudformation' || service === 'iam') {
    return {
      status: error.status,
      contentType: 'text/xml',
      body:
        `<ErrorResponse xmlns="${QUERY_NAMESPACES[service] ?? ''}"><Error><Type>Sender</Type><Code>${error.code}</Code>` +
        `<Message>${error.message}</Message></Error><RequestId>scripted</RequestId></ErrorResponse>`,
    };
  }
  const contentType = JSON_CONTENT_TYPES[service];
  if (contentType !== undefined) {
    return { status: error.status, contentType, body: JSON.stringify({ __type: error.code, message: error.message }) };
  }
  return {
    status: error.status,
    contentType: 'application/json',
    body: JSON.stringify({ message: error.message }),
    headers: { 'x-amzn-errortype': error.code },
  };
}

async function bodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') {
    return body;
  }
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}
