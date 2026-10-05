// Lambda entry of the controlled refund provider (design §9.4: synchronous Invoke of the
// published version, 30 s timeout). Clients are created lazily on the first invocation, and
// nothing compiles a schema at load time (RK-01). Every invocation gets a new journal source
// instance through the composition. A ProviderFault is logged as one JSON line and rethrown,
// so Lambda returns a function error (design §9.9 FAILED/DISPATCHED).

import { createStoreDynamoDbClient } from '../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../durable-store/aws/dynamodb-item-store.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import { systemRuntime } from './node/system-runtime.ts';
import { composeRefundProvider } from './provider-composition.ts';
import { parseProviderEnvironment } from './provider-environment.ts';
import { ProviderFault } from './provider-fault.ts';
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

export async function handler(event: JsonValue): Promise<ProviderInvocationResult> {
  try {
    return await providerInstance().handle(event);
  } catch (error) {
    if (error instanceof ProviderFault) {
      process.stderr.write(`${JSON.stringify(error.toLog())}\n`);
    }
    throw error;
  }
}
