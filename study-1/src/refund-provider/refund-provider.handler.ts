// Lambda entry of the controlled refund provider (design §9.4: synchronous Invoke of the
// published version, 30 s timeout). Clients are created lazily on the first invocation, and
// nothing compiles a schema at load time (RK-01). Every invocation gets a new journal source
// instance through the composition. A ProviderFault, or any other error, is logged as one JSON
// line and rethrown, so Lambda returns a function error (design §9.9 FAILED/DISPATCHED). The
// provider's own diagnostics go to the same stderr sink.

import { createStoreDynamoDbClient } from '../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../durable-store/aws/dynamodb-item-store.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import { systemRuntime } from './node/system-runtime.ts';
import { composeRefundProvider } from './provider-composition.ts';
import { parseProviderEnvironment } from './provider-environment.ts';
import { ProviderFault, unexpectedErrorLog } from './provider-fault.ts';
import { jsonLineLogSink } from './provider-log.ts';
import type { ProviderInvocationResult, RefundProvider } from './refund-provider.ts';

const writeLog = jsonLineLogSink((text) => {
  process.stderr.write(text);
});

let provider: RefundProvider | undefined;

function providerInstance(): RefundProvider {
  if (provider !== undefined) {
    return provider;
  }
  const environment = parseProviderEnvironment(process.env);
  if (!environment.ok) {
    throw new Error(environment.error);
  }
  const store = createDynamoDbItemStore(environment.value.tables, createStoreDynamoDbClient());
  const deployment = environment.value.deployment;
  provider = composeRefundProvider({ deployment, store, ...systemRuntime(), log: writeLog });
  return provider;
}

/**
 * The Lambda entry: routes the parsed Invoke payload to the provider, logs any failure as one
 * JSON line on stderr and rethrows it as the function error.
 *
 * @example
 * const response = await handler({ schema_version: 1, record_type: 'provider_refund_call', ... });
 */
export async function handler(event: JsonValue): Promise<ProviderInvocationResult> {
  try {
    return await providerInstance().handle(event);
  } catch (error) {
    writeLog(error instanceof ProviderFault ? error.toLog() : unexpectedErrorLog(error));
    throw error;
  }
}
