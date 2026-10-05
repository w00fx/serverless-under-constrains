// The Lambda binding of the invocation port (BR-RUA-053, design §9.4, §9.9; RK-05): a real
// LambdaClient serializes, signs and deserializes through a RecordingHttpHandler, so the test
// sees the exact Invoke request on the wire and the exact mapping of every response and error.
// The port never rejects, a throttled Invoke is not retried, and an aborted signal settles as an
// AbortError transport error.

import assert from 'node:assert/strict';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { describe, it } from 'node:test';

import { createProviderLambdaClient } from '../../../src/provider-client/aws/provider-lambda-client.ts';
import { createProviderInvoker } from '../../../src/provider-client/aws/provider-lambda-invoker.ts';
import type { ProviderInvocationPort } from '../../../src/provider-client/provider-invocation-port.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { jsonBytes, PROVIDER_CALL, transportError } from '../../support/provider-client/provider-client-fixtures.ts';
import type { RecordingHttpHandler } from '../../support/provider-client/recording-http-handler.ts';
import { SpyHttpHandlerFactory } from '../../support/provider-client/spy-http-handler-factory.ts';

const FUNCTION_NAME = 'suc-provider';
const TEST_CREDENTIALS = { accessKeyId: 'AKIDPROVIDERCLIENT', secretAccessKey: 'not-a-secret' };
const PAYLOAD = jsonBytes({ outcome: 'SUCCEEDED' });

function setup(): { readonly invoker: ProviderInvocationPort; readonly http: RecordingHttpHandler } {
  const factory = new SpyHttpHandlerFactory();
  const client = createProviderLambdaClient(factory.create, { credentials: TEST_CREDENTIALS });
  return {
    invoker: createProviderInvoker(client, { function_name: FUNCTION_NAME, qualifier: '7' }),
    http: factory.onlyHandler(),
  };
}

describe('createProviderInvoker', () => {
  it('sends one synchronous Invoke of the qualified version with the canonical call', async () => {
    const { invoker, http } = setup();
    http.respondWith({ kind: 'invoke_response', status: 200, executed_version: '7', payload: PAYLOAD });
    const signal = new AbortController().signal;
    await invoker.invoke(PROVIDER_CALL, signal);
    const [request, ...others] = http.requests();
    assert.deepEqual(others, []);
    assert.ok(request !== undefined);
    assert.equal(request.method, 'POST');
    assert.equal(request.path, `/2015-03-31/functions/${FUNCTION_NAME}/invocations`);
    assert.deepEqual(request.query, { Qualifier: '7' });
    assert.equal(request.headers['x-amz-invocation-type'], 'RequestResponse');
    assert.equal(new TextDecoder().decode(request.body), canonicalJson(PROVIDER_CALL as unknown as JsonValue));
    assert.equal(request.abort_signal, signal);
  });

  it('maps the Invoke output field by field onto a response settlement', async () => {
    const { invoker, http } = setup();
    http.respondWith({ kind: 'invoke_response', status: 200, executed_version: '7', payload: PAYLOAD });
    http.respondWith({
      kind: 'invoke_response',
      status: 200,
      executed_version: '6',
      function_error: 'Unhandled',
      payload: PAYLOAD,
    });
    http.respondWith({ kind: 'invoke_response', status: 202, payload: new Uint8Array() });
    const signal = new AbortController().signal;
    assert.deepEqual(await invoker.invoke(PROVIDER_CALL, signal), {
      kind: 'response',
      status_code: 200,
      executed_version: '7',
      function_error: undefined,
      payload: PAYLOAD,
    });
    assert.deepEqual(await invoker.invoke(PROVIDER_CALL, signal), {
      kind: 'response',
      status_code: 200,
      executed_version: '6',
      function_error: 'Unhandled',
      payload: PAYLOAD,
    });
    assert.deepEqual(await invoker.invoke(PROVIDER_CALL, signal), {
      kind: 'response',
      status_code: 202,
      executed_version: undefined,
      function_error: undefined,
      payload: new Uint8Array(),
    });
  });

  it('a throttled Invoke settles as a transport error with its HTTP status and is never retried', async () => {
    const { invoker, http } = setup();
    http.respondWith({
      kind: 'service_error',
      status: 429,
      type: 'TooManyRequestsException',
      message: 'Rate exceeded',
    });
    const result = await invoker.invoke(PROVIDER_CALL, new AbortController().signal);
    assert.deepEqual(result, transportError('TooManyRequestsException', 'Rate exceeded', 429));
    assert.equal(http.requests().length, 1);
  });

  it('a network error settles as a transport error without an HTTP status', async () => {
    const { invoker, http } = setup();
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    http.respondWith({ kind: 'network_error', error: reset });
    const result = await invoker.invoke(PROVIDER_CALL, new AbortController().signal);
    assert.deepEqual(result, transportError('Error', 'socket hang up'));
    assert.equal(http.requests().length, 1);
  });

  it('aborting the signal settles an in-flight Invoke as an AbortError transport error', async () => {
    const { invoker, http } = setup();
    http.respondWith({ kind: 'hang_until_abort' });
    const controller = new AbortController();
    const pending = invoker.invoke(PROVIDER_CALL, controller.signal);
    while (http.requests().length === 0) {
      await nextMacrotask();
    }
    controller.abort();
    assert.deepEqual(await pending, transportError('AbortError', 'Request aborted'));
    assert.equal(http.requests().length, 1);
  });

  it('an already-aborted signal settles as an AbortError transport error', async () => {
    const { invoker } = setup();
    const controller = new AbortController();
    controller.abort();
    const result = await invoker.invoke(PROVIDER_CALL, controller.signal);
    assert.equal(result.kind, 'transport_error');
    assert.equal(result.error_name, 'AbortError');
  });
});
