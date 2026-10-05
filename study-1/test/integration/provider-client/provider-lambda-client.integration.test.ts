// The provider Lambda client factory (BR-RUA-053, design §9.4, §9.13 cases 1 and 3; RK-05):
// the real SDK config resolution keeps one attempt even when AWS_MAX_ATTEMPTS asks for more, the
// HTTP handler is the one the injected factory built from the fixed options, and the production
// handler disables every timeout and keeps the connection alive. Nothing reaches the network.

import assert from 'node:assert/strict';
import type { Agent } from 'node:https';
import { after, before, describe, it } from 'node:test';

import {
  createKeepAliveHttpHandler,
  createProviderLambdaClient,
} from '../../../src/provider-client/aws/provider-lambda-client.ts';
import type { ProviderLambdaClientSettings } from '../../../src/provider-client/aws/provider-lambda-client.ts';
import { PROVIDER_HTTP_HANDLER_OPTIONS } from '../../../src/provider-client/transport-options.ts';
import { invokeHttpRequest } from '../../support/provider-client/provider-client-fixtures.ts';
import { SpyHttpHandlerFactory } from '../../support/provider-client/spy-http-handler-factory.ts';

const TEST_CREDENTIALS = { accessKeyId: 'AKIDPROVIDERCLIENT', secretAccessKey: 'not-a-secret' };

describe('createProviderLambdaClient', () => {
  const saved = process.env['AWS_MAX_ATTEMPTS'];
  before(() => {
    process.env['AWS_MAX_ATTEMPTS'] = '5';
  });
  after(() => {
    if (saved === undefined) {
      delete process.env['AWS_MAX_ATTEMPTS'];
      return;
    }
    process.env['AWS_MAX_ATTEMPTS'] = saved;
  });

  it('resolves maxAttempts 1 in us-east-1 even when AWS_MAX_ATTEMPTS=5', async () => {
    const factory = new SpyHttpHandlerFactory();
    const client = createProviderLambdaClient(factory.create, { credentials: TEST_CREDENTIALS });
    assert.equal(await client.config.maxAttempts(), 1);
    assert.equal(await client.config.region(), 'us-east-1');
  });

  it('builds its handler once through the factory, from the fixed options, and uses it', () => {
    const factory = new SpyHttpHandlerFactory();
    const client = createProviderLambdaClient(factory.create, { credentials: TEST_CREDENTIALS });
    assert.deepEqual(factory.receivedOptions(), [PROVIDER_HTTP_HANDLER_OPTIONS]);
    assert.equal(client.config.requestHandler, factory.onlyHandler());
  });

  it('ignores retry, region and handler settings smuggled past the type', async () => {
    const factory = new SpyHttpHandlerFactory();
    const smuggled = {
      credentials: TEST_CREDENTIALS,
      maxAttempts: 9,
      region: 'eu-west-1',
      requestHandler: new SpyHttpHandlerFactory().create(PROVIDER_HTTP_HANDLER_OPTIONS),
    } as unknown as ProviderLambdaClientSettings;
    const client = createProviderLambdaClient(factory.create, smuggled);
    assert.equal(await client.config.maxAttempts(), 1);
    assert.equal(await client.config.region(), 'us-east-1');
    assert.equal(client.config.requestHandler, factory.onlyHandler());
  });
});

describe('createKeepAliveHttpHandler', () => {
  it('disables every timeout and uses a keep-alive HTTPS agent', async () => {
    const handler = createKeepAliveHttpHandler(PROVIDER_HTTP_HANDLER_OPTIONS);
    // NodeHttpHandler resolves its configuration on the first request (CF V-2); an aborted
    // signal makes that request reject before any socket is opened.
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(handler.handle(invokeHttpRequest(), { abortSignal: controller.signal }), {
      name: 'AbortError',
      message: 'Request aborted',
    });
    const config = handler.httpHandlerConfigs();
    assert.equal(config.connectionTimeout, 0);
    assert.equal(config.requestTimeout, 0);
    assert.equal(config.socketTimeout, 0);
    assert.equal(config.throwOnRequestTimeout, false);
    assert.equal((config.httpsAgent as Agent).options.keepAlive, true);
  });
});
