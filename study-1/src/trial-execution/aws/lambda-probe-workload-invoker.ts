// The Lambda binding of the probe workload invoker (design §9.4 `probe-caller` row, §10.2 T6 for
// the probe; BR-RUA-027, AC-RUA-053). Thin by construction: one `invokeWorkload` sends exactly one
// synchronous `Invoke` (`RequestResponse`) of the probe caller's published version (stack outputs
// `ProbeCallerFunctionName`, `ProbeCallerVersion`) with the canonical `probe_workload_request`,
// and maps what came back with the pure mappers of probe-invocation.ts, which also judges it.
//
// The client comes from `createProviderLambdaClient`: `maxAttempts: 1`, so the Invoke is never
// retried (Lambda does not retry synchronous invokes either), and every HTTP timeout disabled, so
// no client timeout can end the call before the probe caller's own 10 s function timeout.
// UNVERIFIED (cloud phase): that `$metadata.requestId` of a synchronous Invoke equals the probe
// caller's `context.awsRequestId`, which the oracle's invocation cross-check relies on.

import { InvokeCommand } from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import type { JsonValue } from '../../record-contract/primitives.ts';
import type { ProbeWorkloadRequest } from '../../record-contract/records/group-a/probe_workload_request.ts';
import { lambdaInvokeResponseOf, probeInvokeFailureOf } from '../probe-invocation.ts';
import type { ProbeWorkloadInvokeResult, ProbeWorkloadInvoker } from '../trial-execution-ports.ts';

/** The probe caller's published version the runner invokes. */
export interface ProbeCallerTarget {
  /** Stack output `ProbeCallerFunctionName`. */
  readonly function_name: string;
  /** Stack output `ProbeCallerVersion`: an immutable version number, never `$LATEST` or an alias. */
  readonly version: string;
}

/**
 * Binds the probe workload invoker to `client` (built with `createProviderLambdaClient`).
 *
 * @example
 * const workload = createLambdaProbeWorkloadInvoker(createProviderLambdaClient(createKeepAliveHttpHandler), { function_name, version: '1' });
 */
export function createLambdaProbeWorkloadInvoker(
  client: LambdaClient,
  target: ProbeCallerTarget,
): ProbeWorkloadInvoker {
  return {
    invokeWorkload: async (request: ProbeWorkloadRequest): Promise<ProbeWorkloadInvokeResult> => {
      const command = new InvokeCommand({
        FunctionName: target.function_name,
        Qualifier: target.version,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(canonicalJson(request as unknown as JsonValue)),
      });
      try {
        return lambdaInvokeResponseOf(await client.send(command));
      } catch (thrown) {
        return probeInvokeFailureOf(thrown);
      }
    },
  };
}
