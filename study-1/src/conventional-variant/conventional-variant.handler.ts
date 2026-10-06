// Lambda entry of the conventional caller (design §9.4-9.5: SQS FIFO event source mapping on the
// `live` alias, BatchSize 1, 10 s timeout). Clients are created lazily on the first invocation,
// and nothing compiles a schema at load time (RK-01). A completed delivery returns, so the event
// source mapping deletes the message; a propagated failure or a fault is logged as one JSON line
// and thrown, so the message returns after the visibility timeout (BR-RUA-020). The logging and
// rethrow live in conventional-lambda-entry.ts, where tests reach them; this shell only wires.

import { createStoreDynamoDbClient } from '../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../durable-store/aws/dynamodb-item-store.ts';
import {
  createKeepAliveHttpHandler,
  createProviderLambdaClient,
} from '../provider-client/aws/provider-lambda-client.ts';
import { createProviderInvoker } from '../provider-client/aws/provider-lambda-invoker.ts';
import { composeConventionalConsumer } from './conventional-composition.ts';
import type { ConventionalRefundConsumer } from './conventional-consumer.ts';
import { parseConventionalEnvironment } from './conventional-environment.ts';
import { createConventionalLambdaEntry } from './conventional-lambda-entry.ts';
import { conventionalSystemRuntime } from './node/system-runtime.ts';

let consumer: ConventionalRefundConsumer | undefined;

function consumerInstance(): ConventionalRefundConsumer {
  if (consumer !== undefined) {
    return consumer;
  }
  const environment = parseConventionalEnvironment(process.env);
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
  consumer = composeConventionalConsumer({
    deployment,
    provider_qualifier,
    store,
    invoker,
    ...conventionalSystemRuntime(),
  });
  return consumer;
}

/**
 * The Lambda entry: one SQS delivery per invocation (BatchSize 1).
 *
 * @example
 * await handler(sqsEvent, { awsRequestId: 'req-1' }); // resolves when the delivery completed
 */
export const handler = createConventionalLambdaEntry({
  consumer: consumerInstance,
  log: { write: (line) => process.stderr.write(`${JSON.stringify(line)}\n`) },
});
