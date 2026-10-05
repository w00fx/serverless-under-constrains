// The Lambda binding of the provider invocation port: one synchronous `Invoke`
// (`InvocationType: RequestResponse`) of the provider's immutable version (BR-RUA-053, design
// §9.4). The call is sent as canonical JSON. The Invoke output maps field by field onto a
// `response` settlement (`StatusCode`, `ExecutedVersion`, `FunctionError`, `Payload`), and every
// error the client throws, the `AbortError` of an aborted signal included, maps onto a
// `transport_error` settlement, so the port never rejects.

import { InvokeCommand } from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import type { JsonValue } from '../../record-contract/primitives.ts';
import type { ProviderRefundCall } from '../../record-contract/records/group-a/provider_refund_call.ts';
import type {
  ProviderInvocationPort,
  ProviderTransportError,
  ProviderTransportResult,
} from '../provider-invocation-port.ts';
import { transportErrorFromThrown } from '../provider-invocation-port.ts';

/** The provider function version a caller invokes. */
export interface ProviderTarget {
  /** The provider function name or ARN (`SUC_PROVIDER_FUNCTION_NAME`). */
  readonly function_name: string;
  /** The immutable version number (`SUC_PROVIDER_QUALIFIER`), never `$LATEST` or an alias. */
  readonly qualifier: string;
}

/**
 * Binds the invocation port to `client` and the provider version `target`.
 *
 * @example
 * const invoker = createProviderInvoker(client, { function_name: env.SUC_PROVIDER_FUNCTION_NAME, qualifier: env.SUC_PROVIDER_QUALIFIER });
 */
export function createProviderInvoker(client: LambdaClient, target: ProviderTarget): ProviderInvocationPort {
  return {
    invoke: async (call: ProviderRefundCall, signal: AbortSignal): Promise<ProviderTransportResult> => {
      const command = new InvokeCommand({
        FunctionName: target.function_name,
        Qualifier: target.qualifier,
        InvocationType: 'RequestResponse',
        Payload: new TextEncoder().encode(canonicalJson(call as unknown as JsonValue)),
      });
      try {
        const output = await client.send(command, { abortSignal: signal });
        return {
          kind: 'response',
          status_code: output.StatusCode ?? 0,
          executed_version: output.ExecutedVersion,
          function_error: output.FunctionError,
          // A plain copy: the SDK's Uint8ArrayBlobAdapter must not leak past the port.
          payload: Uint8Array.from(output.Payload ?? []),
        };
      } catch (thrown) {
        return withHttpStatus(transportErrorFromThrown(thrown), thrown);
      }
    },
  };
}

// AWS SDK service exceptions carry the HTTP status in `$metadata.httpStatusCode`.
function withHttpStatus(error: ProviderTransportError, thrown: unknown): ProviderTransportError {
  const status = (thrown as { readonly $metadata?: { readonly httpStatusCode?: unknown } } | undefined)?.$metadata
    ?.httpStatusCode;
  return typeof status === 'number' ? { ...error, http_status: status } : error;
}
