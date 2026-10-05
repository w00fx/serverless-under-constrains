// A real DynamoDBClient, built by the production factory, over a recording HTTP handler
// (design §12.1 integration boundary, §12.2 `RecordingDynamoDbClient`). The SDK's own
// serializer, signer, retry middleware and error deserializer all run; only the network is
// replaced. Each request is recorded as the decoded JSON body of its
// `X-Amz-Target: DynamoDB_20120810.<Operation>` call, so tests assert `ConsistentRead`,
// `ClientRequestToken` and `ReturnValuesOnConditionCheckFailure` on the wire, and each
// response is scripted in the DynamoDB JSON 1.0 protocol: errors carry
// `__type: com.amazonaws.dynamodb.v20120810#<Name>` with HTTP 400 or 500
// (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Programming.Errors.html).

import { Readable } from 'node:stream';

import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { HttpRequest, HttpResponse } from '@smithy/types';

import { createStoreDynamoDbClient } from '../../../../src/durable-store/aws/dynamodb-client.ts';
import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';

export const DYNAMODB_TARGET_PREFIX = 'DynamoDB_20120810.';
export const DYNAMODB_ERROR_TYPE_PREFIX = 'com.amazonaws.dynamodb.v20120810#';

export interface RecordedDynamoDbCall {
  readonly operation: string;
  readonly input: JsonValue;
  readonly hostname: string;
  readonly attempt_header: string | undefined;
}

export type ScriptedDynamoDbResponse =
  | { readonly kind: 'success'; readonly body: JsonObject }
  | { readonly kind: 'service_error'; readonly status: number; readonly type: string; readonly body: JsonObject }
  | { readonly kind: 'raw'; readonly status: number; readonly body: string }
  | { readonly kind: 'network_error'; readonly error: Error };

export class RecordingDynamoDbClient {
  readonly client: DynamoDBClient;
  readonly #calls: RecordedDynamoDbCall[] = [];
  readonly #responses: ScriptedDynamoDbResponse[] = [];

  constructor() {
    this.client = createStoreDynamoDbClient({
      credentials: { accessKeyId: 'AKIDRECORDINGCLIENT', secretAccessKey: 'recording-client-not-a-secret' },
      requestHandler: { handle: (request: HttpRequest) => this.#handle(request) },
    });
  }

  /** Queues the response to the next request. Responses are consumed in order. */
  respondWith(response: ScriptedDynamoDbResponse): void {
    this.#responses.push(response);
  }

  /** Queues an HTTP 200 with this JSON body (`{}` is an empty success). */
  respondWithSuccess(body: JsonObject = {}): void {
    this.respondWith({ kind: 'success', body });
  }

  /** Queues a DynamoDB error response: HTTP 400 unless `status` says otherwise. */
  respondWithServiceError(type: string, body: JsonObject = {}, status = 400): void {
    this.respondWith({ kind: 'service_error', status, type, body });
  }

  calls(): readonly RecordedDynamoDbCall[] {
    return [...this.#calls];
  }

  pendingResponseCount(): number {
    return this.#responses.length;
  }

  async #handle(request: HttpRequest): Promise<{ response: HttpResponse }> {
    const target = request.headers['x-amz-target'] ?? '';
    const operation = target.startsWith(DYNAMODB_TARGET_PREFIX) ? target.slice(DYNAMODB_TARGET_PREFIX.length) : target;
    this.#calls.push({
      operation,
      input: JSON.parse(bodyText(request.body)) as JsonValue,
      hostname: request.hostname,
      attempt_header: request.headers['amz-sdk-request'],
    });
    const scripted = this.#responses.shift();
    if (scripted === undefined) {
      throw new Error(`no scripted response for ${JSON.stringify(target)}; expected respondWith(...) before the call`);
    }
    if (scripted.kind === 'network_error') {
      throw scripted.error;
    }
    return Promise.resolve({ response: httpResponse(scripted) });
  }
}

function httpResponse(scripted: Exclude<ScriptedDynamoDbResponse, { kind: 'network_error' }>): HttpResponse {
  const [status, text] = responseContent(scripted);
  return {
    statusCode: status,
    headers: { 'content-type': 'application/x-amz-json-1.0' },
    body: Readable.from([Buffer.from(text, 'utf8')]),
  };
}

function responseContent(scripted: Exclude<ScriptedDynamoDbResponse, { kind: 'network_error' }>): [number, string] {
  switch (scripted.kind) {
    case 'success':
      return [200, JSON.stringify(scripted.body)];
    case 'service_error':
      return [
        scripted.status,
        JSON.stringify({ __type: `${DYNAMODB_ERROR_TYPE_PREFIX}${scripted.type}`, ...scripted.body }),
      ];
    case 'raw':
      return [scripted.status, scripted.body];
  }
}

// The awsJson1_0 serializer hands the request handler the JSON body as UTF-8 bytes; anything else
// means the SDK changed underneath the recorder, so it fails loudly instead of recording a guess.
function bodyText(body: unknown): string {
  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }
  throw new TypeError(`request body is ${typeof body}; expected the SDK's Uint8Array JSON body`);
}
