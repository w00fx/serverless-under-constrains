// A NodeHttpHandler whose network is replaced by scripted responses (design §12.2
// `RecordingHttpHandler`), so a real LambdaClient runs its own serializer, signer, retry
// middleware and deserializer end to end. It records every request with the abort signal the
// client handed it. Responses follow the Lambda REST-JSON protocol of the Invoke API
// (https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html): the status code is
// `StatusCode`, the `X-Amz-Executed-Version` and `X-Amz-Function-Error` headers carry
// `ExecutedVersion` and `FunctionError`, the body is `Payload`, and a service error names its
// type in the `X-Amzn-ErrorType` header.
//
// `hangUntilAbort()` never answers; when the signal aborts it rejects exactly as the real handler
// does: `@smithy/node-http-handler` 4.12.1 `buildAbortError` gives an Error named `AbortError`
// with the message `Request aborted`, and an already-aborted signal rejects before sending.

import { Readable } from 'node:stream';

import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { HttpHandlerOptions, HttpRequest, HttpResponse } from '@smithy/types';

export type ScriptedHttpResponse =
  | {
      readonly kind: 'invoke_response';
      readonly status: number;
      readonly executed_version?: string;
      readonly function_error?: string;
      readonly payload: Uint8Array;
    }
  | { readonly kind: 'service_error'; readonly status: number; readonly type: string; readonly message: string }
  | { readonly kind: 'network_error'; readonly error: Error }
  | { readonly kind: 'hang_until_abort' };

export interface RecordedHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly abort_signal: AbortSignal | undefined;
}

export class RecordingHttpHandler extends NodeHttpHandler {
  readonly #requests: RecordedHttpRequest[] = [];
  readonly #responses: ScriptedHttpResponse[] = [];

  /** Queues the response to the next request; responses are consumed in order. */
  respondWith(response: ScriptedHttpResponse): void {
    this.#responses.push(response);
  }

  requests(): readonly RecordedHttpRequest[] {
    return [...this.#requests];
  }

  override handle(request: HttpRequest, options: HttpHandlerOptions = {}): Promise<{ response: HttpResponse }> {
    const signal = options.abortSignal as AbortSignal | undefined;
    this.#requests.push({
      method: request.method,
      path: request.path,
      query: { ...request.query },
      headers: { ...request.headers },
      body: requestBody(request.body),
      abort_signal: signal,
    });
    if (signal?.aborted === true) {
      return Promise.reject(abortError());
    }
    const scripted = this.#responses.shift();
    if (scripted === undefined) {
      return Promise.reject(
        new Error(`no scripted response for ${request.method} ${request.path}; expected respondWith(...) first`),
      );
    }
    return settle(scripted, signal);
  }
}

function settle(scripted: ScriptedHttpResponse, signal: AbortSignal | undefined): Promise<{ response: HttpResponse }> {
  switch (scripted.kind) {
    case 'network_error':
      return Promise.reject(scripted.error);
    case 'hang_until_abort':
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(abortError());
        });
      });
    case 'service_error':
      return Promise.resolve({
        response: httpResponse(
          scripted.status,
          { 'x-amzn-errortype': scripted.type, 'content-type': 'application/json' },
          new TextEncoder().encode(JSON.stringify({ message: scripted.message, Type: 'User' })),
        ),
      });
    case 'invoke_response':
      return Promise.resolve({ response: httpResponse(scripted.status, invokeHeaders(scripted), scripted.payload) });
  }
}

function invokeHeaders(scripted: Extract<ScriptedHttpResponse, { kind: 'invoke_response' }>): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(scripted.executed_version === undefined ? {} : { 'x-amz-executed-version': scripted.executed_version }),
    ...(scripted.function_error === undefined ? {} : { 'x-amz-function-error': scripted.function_error }),
  };
}

function httpResponse(status: number, headers: Record<string, string>, body: Uint8Array): HttpResponse {
  return { statusCode: status, headers, body: Readable.from([Buffer.from(body)]) };
}

function abortError(): Error {
  const error = new Error('Request aborted');
  error.name = 'AbortError';
  return error;
}

// The REST-JSON serializer hands the handler the Invoke payload as bytes; anything else means
// the SDK changed underneath the recorder, so it fails loudly instead of recording a guess.
function requestBody(body: unknown): Uint8Array {
  if (body instanceof Uint8Array) {
    return body;
  }
  throw new TypeError(`request body is ${typeof body}; expected the SDK's Uint8Array Invoke payload`);
}
