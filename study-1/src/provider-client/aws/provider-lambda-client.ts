// The one way a caller builds its Lambda client for provider invocations (BR-RUA-053, design
// §9.4, §9.13 cases 1 and 3; RK-05):
// - `maxAttempts: 1` overrides `AWS_MAX_ATTEMPTS` and the default retry strategy, so a timed-out
//   Invoke is never re-sent as a hidden second provider call;
// - the HTTP handler is built explicitly by an injected factory with every timeout disabled, so
//   neither `defaultsMode` nor a default handler can inject a timeout that preempts the 3 s
//   deadline. `NodeHttpHandler#httpHandlerConfigs()` returns `{}` until the first request
//   (CF V-2), so tests observe the options at the factory instead.

import { Agent } from 'node:https';

import { LambdaClient } from '@aws-sdk/client-lambda';
import type { LambdaClientConfig } from '@aws-sdk/client-lambda';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import type { ProviderHttpHandlerOptions } from '../transport-options.ts';
import { PROVIDER_HTTP_HANDLER_OPTIONS, PROVIDER_LAMBDA_CLIENT_OPTIONS } from '../transport-options.ts';

/** Builds the HTTP handler of the provider client from the fixed options. */
export type HttpHandlerFactory = (options: ProviderHttpHandlerOptions) => NodeHttpHandler;

/**
 * The only client setting a caller may supply: the credentials (tests pass static ones). It is
 * an allow-list, not an `Omit` of `LambdaClientConfig`, because any other key can reach the
 * transport: `extensions` can replace the HTTP handler through `setHttpHandler`, and a
 * handler with its own request timeout would preempt the 3 s deadline (BR-RUA-028, BR-RUA-053;
 * WP-06 review round 1). Keys smuggled past the type are dropped at run time.
 */
export interface ProviderLambdaClientSettings {
  readonly credentials?: LambdaClientConfig['credentials'];
}

/**
 * The production HTTP handler: the fixed timeouts plus a keep-alive HTTPS agent, so a warm
 * caller reuses its TLS connection to the Lambda endpoint (RK-01).
 *
 * @example
 * const client = createProviderLambdaClient(createKeepAliveHttpHandler);
 */
export function createKeepAliveHttpHandler(options: ProviderHttpHandlerOptions): NodeHttpHandler {
  return new NodeHttpHandler({
    connectionTimeout: options.connectionTimeout,
    requestTimeout: options.requestTimeout,
    socketTimeout: options.socketTimeout,
    throwOnRequestTimeout: options.throwOnRequestTimeout,
    httpsAgent: new Agent({ keepAlive: options.keepAlive }),
  });
}

/**
 * Builds the Lambda client of the shared provider client. Tests pass a spying factory and
 * static credentials; production passes `createKeepAliveHttpHandler` and nothing else.
 *
 * @example
 * const invoker = createProviderInvoker(createProviderLambdaClient(createKeepAliveHttpHandler), { function_name, qualifier });
 */
export function createProviderLambdaClient(
  handlerFactory: HttpHandlerFactory,
  settings: ProviderLambdaClientSettings = {},
): LambdaClient {
  return new LambdaClient({
    ...(settings.credentials === undefined ? {} : { credentials: settings.credentials }),
    ...PROVIDER_LAMBDA_CLIENT_OPTIONS,
    requestHandler: handlerFactory(PROVIDER_HTTP_HANDLER_OPTIONS),
  });
}
