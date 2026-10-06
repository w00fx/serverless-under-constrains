// A NodeHttpHandler whose network is replaced by scripted Lambda `Invoke` answers (design §12.2;
// Lambda API reference Invoke, https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html), so
// a real LambdaClient built by `createProviderLambdaClient` runs its own serializer, signer, retry
// middleware and deserializer end to end. Unlike the provider client's RecordingHttpHandler it
// answers with the `x-amzn-RequestId` header, which the SDK exposes as `$metadata.requestId` and
// the runner records as `probe_workload_invoked.lambda_request_id`. The status is `StatusCode`,
// `X-Amz-Executed-Version` and `X-Amz-Function-Error` carry `ExecutedVersion` and `FunctionError`,
// the body is `Payload`, and a service error names its type in `X-Amzn-ErrorType`.
//
// `factory` is an HttpHandlerFactory: it records the options the client asked for (every timeout
// disabled) and returns this handler.

import { Readable } from 'node:stream';

import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { HttpHandlerOptions, HttpRequest, HttpResponse } from '@smithy/types';

import type { ProviderHttpHandlerOptions } from '../../../../src/provider-client/transport-options.ts';

export type ScriptedInvoke =
  | {
      readonly kind: 'invoke_response';
      readonly status: number;
      readonly request_id?: string;
      readonly executed_version?: string;
      readonly function_error?: string;
      readonly payload: Uint8Array;
    }
  | { readonly kind: 'service_error'; readonly status: number; readonly type: string; readonly request_id?: string }
  | { readonly kind: 'network_error'; readonly error: Error };

export interface RecordedInvoke {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export class ScriptedLambdaInvokeHandler extends NodeHttpHandler {
  readonly #scripts: ScriptedInvoke[] = [];
  readonly #requests: RecordedInvoke[] = [];
  readonly #options: ProviderHttpHandlerOptions[] = [];

  /** The HttpHandlerFactory handing out this handler. */
  readonly factory = (options: ProviderHttpHandlerOptions): NodeHttpHandler => {
    this.#options.push(options);
    return this;
  };

  /** Queues the answer to the next request. */
  script(invoke: ScriptedInvoke): void {
    this.#scripts.push(invoke);
  }

  requests(): readonly RecordedInvoke[] {
    return [...this.#requests];
  }

  /** The options of every factory call, in order. */
  receivedOptions(): readonly ProviderHttpHandlerOptions[] {
    return [...this.#options];
  }

  override handle(request: HttpRequest, _options: HttpHandlerOptions = {}): Promise<{ response: HttpResponse }> {
    this.#requests.push({
      method: request.method,
      path: request.path,
      query: { ...request.query },
      headers: { ...request.headers },
      body: requestBody(request.body),
    });
    const script = this.#scripts.shift();
    if (script === undefined) {
      return Promise.reject(
        new Error(`no scripted answer for ${request.method} ${request.path}; expected script(...) first`),
      );
    }
    if (script.kind === 'network_error') {
      return Promise.reject(script.error);
    }
    if (script.kind === 'service_error') {
      const headers = { 'x-amzn-errortype': script.type, 'content-type': 'application/json', ...requestId(script) };
      const body = new TextEncoder().encode(JSON.stringify({ message: `scripted ${script.type}`, Type: 'User' }));
      return Promise.resolve({ response: httpResponse(script.status, headers, body) });
    }
    const headers = {
      'content-type': 'application/json',
      ...requestId(script),
      ...(script.executed_version === undefined ? {} : { 'x-amz-executed-version': script.executed_version }),
      ...(script.function_error === undefined ? {} : { 'x-amz-function-error': script.function_error }),
    };
    return Promise.resolve({ response: httpResponse(script.status, headers, script.payload) });
  }
}

function requestId(script: { readonly request_id?: string }): Record<string, string> {
  return script.request_id === undefined ? {} : { 'x-amzn-requestid': script.request_id };
}

function httpResponse(status: number, headers: Record<string, string>, body: Uint8Array): HttpResponse {
  return { statusCode: status, headers, body: Readable.from([Buffer.from(body)]) };
}

// An Invoke without a Payload sends no body at all.
function requestBody(body: unknown): Uint8Array {
  if (body === undefined) {
    return new Uint8Array();
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  throw new TypeError(`request body is ${typeof body}; expected the SDK's Uint8Array Invoke payload`);
}
