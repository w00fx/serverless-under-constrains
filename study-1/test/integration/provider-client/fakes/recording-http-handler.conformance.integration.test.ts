// Conformance of RecordingHttpHandler and SpyHttpHandlerFactory (design §12.2; CF V-2): the
// handler rejects an aborted request exactly as the real `NodeHttpHandler` does, delivers the
// scripted exchanges a real LambdaClient deserializes, records each request with its abort
// signal, and refuses an unscripted request loudly. The factory records the options it was asked
// for and hands out the handler the client then uses.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { NodeHttpHandler } from '@smithy/node-http-handler';

import { PROVIDER_HTTP_HANDLER_OPTIONS } from '../../../../src/provider-client/transport-options.ts';
import { INVOKE_WIRE_FIELDS, invokeHttpRequest } from '../../../support/provider-client/provider-client-fixtures.ts';
import { RecordingHttpHandler } from '../../../support/provider-client/recording-http-handler.ts';
import { SpyHttpHandlerFactory } from '../../../support/provider-client/spy-http-handler-factory.ts';

const REQUEST = invokeHttpRequest();

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

async function rejectionOf(promise: Promise<unknown>): Promise<{ readonly name: string; readonly message: string }> {
  try {
    await promise;
  } catch (thrown) {
    const error = thrown as Error;
    return { name: error.name, message: error.message };
  }
  throw new Error('promise resolved; expected a rejection');
}

describe('RecordingHttpHandler conformance', () => {
  it('rejects an already-aborted request exactly as the real NodeHttpHandler does', async () => {
    const real = await rejectionOf(new NodeHttpHandler().handle(REQUEST, { abortSignal: abortedSignal() }));
    const fake = await rejectionOf(new RecordingHttpHandler().handle(REQUEST, { abortSignal: abortedSignal() }));
    assert.deepEqual(fake, real);
    assert.deepEqual(fake, { name: 'AbortError', message: 'Request aborted' });
  });

  it('rejects an in-flight request when its signal aborts, with the same error', async () => {
    const handler = new RecordingHttpHandler();
    handler.respondWith({ kind: 'hang_until_abort' });
    const controller = new AbortController();
    const pending = handler.handle(REQUEST, { abortSignal: controller.signal });
    controller.abort();
    assert.deepEqual(await rejectionOf(pending), { name: 'AbortError', message: 'Request aborted' });
  });

  it('records each request with its body and signal, and answers in script order', async () => {
    const handler = new RecordingHttpHandler();
    handler.respondWith({ kind: 'invoke_response', status: 200, executed_version: '7', payload: new Uint8Array([1]) });
    handler.respondWith({
      kind: 'service_error',
      status: 429,
      type: 'TooManyRequestsException',
      message: 'Rate exceeded',
    });
    handler.respondWith({ kind: 'network_error', error: new Error('socket hang up') });
    const signal = new AbortController().signal;
    const first = await handler.handle(REQUEST, { abortSignal: signal });
    assert.equal(first.response.statusCode, 200);
    assert.equal(first.response.headers['x-amz-executed-version'], '7');
    assert.equal('x-amz-function-error' in first.response.headers, false);
    const second = await handler.handle(REQUEST);
    assert.equal(second.response.statusCode, 429);
    assert.equal(second.response.headers['x-amzn-errortype'], 'TooManyRequestsException');
    assert.deepEqual(await rejectionOf(handler.handle(REQUEST)), { name: 'Error', message: 'socket hang up' });
    assert.deepEqual(handler.requests(), [
      { ...INVOKE_WIRE_FIELDS, abort_signal: signal },
      { ...INVOKE_WIRE_FIELDS, abort_signal: undefined },
      { ...INVOKE_WIRE_FIELDS, abort_signal: undefined },
    ]);
  });

  it('refuses an unscripted request and a body that is not the SDK payload bytes', async () => {
    const handler = new RecordingHttpHandler();
    assert.deepEqual(await rejectionOf(handler.handle(REQUEST)), {
      name: 'Error',
      message: `no scripted response for POST ${INVOKE_WIRE_FIELDS.path}; expected respondWith(...) first`,
    });
    assert.throws(() => handler.handle(invokeHttpRequest('{}')), {
      name: 'TypeError',
      message: "request body is string; expected the SDK's Uint8Array Invoke payload",
    });
  });
});

describe('SpyHttpHandlerFactory conformance', () => {
  it('records the requested options and hands out one recording handler per call', () => {
    const factory = new SpyHttpHandlerFactory();
    assert.throws(() => factory.onlyHandler(), { message: 'factory created 0 handler(s); expected exactly one' });
    const handler = factory.create(PROVIDER_HTTP_HANDLER_OPTIONS);
    assert.ok(handler instanceof RecordingHttpHandler);
    assert.ok(handler instanceof NodeHttpHandler);
    assert.equal(factory.onlyHandler(), handler);
    factory.create(PROVIDER_HTTP_HANDLER_OPTIONS);
    assert.deepEqual(factory.receivedOptions(), [PROVIDER_HTTP_HANDLER_OPTIONS, PROVIDER_HTTP_HANDLER_OPTIONS]);
    assert.equal(factory.handlers().length, 2);
    assert.throws(() => factory.onlyHandler(), { message: 'factory created 2 handler(s); expected exactly one' });
  });
});
