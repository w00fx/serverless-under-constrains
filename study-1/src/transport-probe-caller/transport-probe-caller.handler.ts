// Lambda entry of the probe caller (design §9.4: synchronous Invoke by the runner, 10 s timeout,
// SDK maxAttempts 1; Lambda does not retry synchronous invokes). Clients are created lazily on
// the first invocation, and nothing compiles a schema at load time (RK-01). A fault is logged as
// one JSON line and rethrown, so the runner sees a function error.

import { createStoreDynamoDbClient } from '../durable-store/aws/dynamodb-client.ts';
import { createDynamoDbItemStore } from '../durable-store/aws/dynamodb-item-store.ts';
import {
  createKeepAliveHttpHandler,
  createProviderLambdaClient,
} from '../provider-client/aws/provider-lambda-client.ts';
import { createProviderInvoker } from '../provider-client/aws/provider-lambda-invoker.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import { probeCallerSystemRuntime } from './node/system-runtime.ts';
import type { ProbeCaller, ProbeWorkloadReport } from './probe-caller.ts';
import { composeProbeCaller } from './probe-caller-composition.ts';
import { parseProbeCallerEnvironment } from './probe-caller-environment.ts';
import { ProbeCallerFault } from './probe-caller-fault.ts';

let caller: ProbeCaller | undefined;

function callerInstance(): ProbeCaller {
  if (caller !== undefined) {
    return caller;
  }
  const environment = parseProbeCallerEnvironment(process.env);
  if (!environment.ok) {
    throw new Error(environment.error);
  }
  const { deployment, caller_journal_table, provider_function_name, provider_qualifier } = environment.value;
  const store = createDynamoDbItemStore({ caller_journal: caller_journal_table }, createStoreDynamoDbClient());
  const invoker = createProviderInvoker(createProviderLambdaClient(createKeepAliveHttpHandler), {
    function_name: provider_function_name,
    qualifier: provider_qualifier,
  });
  caller = composeProbeCaller({ deployment, provider_qualifier, store, invoker, ...probeCallerSystemRuntime() });
  return caller;
}

export async function handler(
  event: JsonValue,
  context: { readonly awsRequestId: string },
): Promise<ProbeWorkloadReport> {
  try {
    return await callerInstance().run({ payload: event, lambda_request_id: context.awsRequestId });
  } catch (error) {
    const line =
      error instanceof ProbeCallerFault
        ? error.toLog()
        : { level: 'error', event: 'probe_caller_error', detail: String(error) };
    process.stderr.write(`${JSON.stringify(line)}\n`);
    throw error;
  }
}
