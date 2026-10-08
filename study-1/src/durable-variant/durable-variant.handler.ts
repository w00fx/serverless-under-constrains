// Lambda entry of the Durable caller (design §9.4-9.5: SQS FIFO event source mapping on the
// `live` alias, BatchSize 1, 10 s per invocation, `durableConfig` 300 s / 1 day). The caller and
// its clients are created lazily on the first step attempt, and nothing compiles a schema at
// load time (RK-01). The retry delay is the deployed OR-RUA-002 constant, never a variable.

import { createStoreDynamoDbClient } from '../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../durable-store/aws/dynamodb-item-store.ts';
import {
  createKeepAliveHttpHandler,
  createProviderLambdaClient,
} from '../provider-client/aws/provider-lambda-client.ts';
import { createProviderInvoker } from '../provider-client/aws/provider-lambda-invoker.ts';
import { composeDurableCaller } from './durable-composition.ts';
import { parseDurableEnvironment } from './durable-environment.ts';
import type { DurableRefundCaller } from './durable-refund-caller.ts';
import { createDurableRefundHandler } from './durable-refund-handler.ts';
import { DEPLOYED_DURABLE_RETRY } from './durable-retry.ts';
import { durableSystemRuntime } from './node/system-runtime.ts';

let caller: DurableRefundCaller | undefined;

function callerInstance(): DurableRefundCaller {
  if (caller !== undefined) {
    return caller;
  }
  const environment = parseDurableEnvironment(process.env);
  if (!environment.ok) {
    throw new Error(environment.error);
  }
  const { deployment, caller_journal_table, trial_registry_table, provider_function_name, provider_qualifier } =
    environment.value;
  const store = createDynamoDbItemStore(
    { caller_journal: caller_journal_table, trial_registry: trial_registry_table },
    createStoreDynamoDbClient(),
  );
  const invoker = createProviderInvoker(createProviderLambdaClient(createKeepAliveHttpHandler), {
    function_name: provider_function_name,
    qualifier: provider_qualifier,
  });
  caller = composeDurableCaller({ deployment, provider_qualifier, store, invoker, ...durableSystemRuntime() });
  return caller;
}

/** The Lambda entry: one durable execution per SQS delivery (BatchSize 1). */
export const handler = createDurableRefundHandler(
  {
    caller: callerInstance,
    log: { write: (line) => process.stderr.write(`${JSON.stringify(line)}\n`) },
  },
  DEPLOYED_DURABLE_RETRY,
);
