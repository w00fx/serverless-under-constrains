// Lambda entry of the controlled refund provider (design §9.4: synchronous Invoke of the
// published version, 30 s timeout). Clients are created lazily on the first invocation, and
// nothing compiles a schema at load time (RK-01). Every invocation gets a new journal source
// instance through the composition. A ProviderFault, or any other error, is logged as one JSON
// line and rethrown, so Lambda returns a function error (design §9.9 FAILED/DISPATCHED).

import { createStoreDynamoDbClient } from '../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../durable-store/aws/dynamodb-item-store.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import { systemRuntime } from './node/system-runtime.ts';
import { composeRefundProvider } from './provider-composition.ts';
import { parseProviderEnvironment } from './provider-environment.ts';
import { ProviderFault, unexpectedErrorLog } from './provider-fault.ts';
import type { ProviderInvocationResult, RefundProvider } from './refund-provider.ts';

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
  provider = composeRefundProvider({ deployment: environment.value.deployment, store, ...systemRuntime() });
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
    const line = error instanceof ProviderFault ? error.toLog() : unexpectedErrorLog(error);
    process.stderr.write(`${JSON.stringify(line)}\n`);
    throw error;
  }
}
