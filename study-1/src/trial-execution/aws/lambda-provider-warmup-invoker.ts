// The Lambda binding of the runner's provider warm-up (addendum §2.1, design §5.3
// `ProviderWarmupInvoker`; BR-RUA-053). Thin by construction: one `invokeWarmup` sends exactly one
// synchronous `Invoke` (`RequestResponse`) of the provider's published version with the canonical
// `provider_warmup_request`, and maps what came back with the pure mappers of runner-warmup.ts,
// which also judges the settlement.
//
// The client comes from `createProviderLambdaClient`, the one way the study builds a Lambda client
// for provider invocations: `maxAttempts: 1` and every HTTP timeout disabled, so a slow warm-up is
// never re-sent as a hidden second provider invocation.

import { InvokeCommand } from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';

import type { ProviderTarget } from '../../provider-client/aws/provider-lambda-invoker.ts';
import type { ProviderTransportResult } from '../../provider-client/provider-invocation-port.ts';
import { canonicalJson } from '../../record-contract/canonical-json.ts';
import type { JsonValue } from '../../record-contract/primitives.ts';
import type { ProviderWarmupRequest } from '../../record-contract/records/group-b/provider_warmup_request.ts';
import { warmupResponseOf, warmupTransportErrorOf } from '../runner-warmup.ts';
import type { ProviderWarmupInvoker } from '../trial-execution-ports.ts';

/**
 * Binds the warm-up to `client` (built with `createProviderLambdaClient`) and the provider's
 * published version (stack outputs `ProviderFunctionName`, `ProviderVersion`).
 *
 * @example
 * const warmup = createLambdaProviderWarmupInvoker(createProviderLambdaClient(createKeepAliveHttpHandler), { function_name, qualifier: '3' });
 */
export function createLambdaProviderWarmupInvoker(client: LambdaClient, target: ProviderTarget): ProviderWarmupInvoker {
  return {
    invokeWarmup: async (request: ProviderWarmupRequest): Promise<ProviderTransportResult> => {
      const command = new InvokeCommand({
        FunctionName: target.function_name,
        Qualifier: target.qualifier,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(canonicalJson(request as unknown as JsonValue)),
      });
      try {
        return warmupResponseOf(await client.send(command));
      } catch (thrown) {
        return warmupTransportErrorOf(thrown);
      }
    },
  };
}
