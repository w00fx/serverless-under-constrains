// The transport port of the shared provider client (design §5.3): one synchronous provider
// invocation per call. Production binds it to a Lambda `Invoke` (`aws/provider-lambda-invoker.ts`);
// offline tests bind it to `ScriptedProviderInvoker`.
//
// The port reports both settlement kinds as values (BR-RUA-053 "both transport-level and
// function-level errors are parsed explicitly"): a `response` is whatever the Invoke API
// returned, including a function error, and a `transport_error` is every way the call failed
// to return one, including the `AbortError` an aborted signal produces.

import type { ProviderRefundCall } from '../record-contract/records/group-a/provider_refund_call.ts';

/** The error name a transport reports when its abort signal stopped it. */
export const ABORT_ERROR_NAME = 'AbortError';

export interface ProviderResponseSettlement {
  readonly kind: 'response';
  /** The Invoke `StatusCode` (200 for a `RequestResponse` invocation). */
  readonly status_code: number;
  /** The Invoke `ExecutedVersion` (`X-Amz-Executed-Version`), when present. */
  readonly executed_version: string | undefined;
  /** The Invoke `FunctionError` (`X-Amz-Function-Error`), when present. */
  readonly function_error: string | undefined;
  /** The raw response payload bytes. */
  readonly payload: Uint8Array;
}

export interface ProviderTransportError {
  readonly kind: 'transport_error';
  readonly error_name: string;
  readonly message: string;
  readonly http_status?: number;
}

export type ProviderTransportResult = ProviderResponseSettlement | ProviderTransportError;

export interface ProviderInvocationPort {
  /** Invokes the provider once; `signal` aborts the call (BR-RUA-023). */
  invoke(call: ProviderRefundCall, signal: AbortSignal): Promise<ProviderTransportResult>;
}

/** The error name of a thrown value whose name or text could not be read. */
export const UNREPRESENTABLE_THROWN_NAME = 'UnrepresentableThrown';

/**
 * The settlement of a port call that threw or rejected instead of returning a result: a
 * transport error named after what was thrown, because the call crossed the dispatch boundary
 * and nothing it threw proves the provider was not reached (BR-RUA-021). Total over every
 * thrown value: a value whose `name`, `message` or string conversion throws (a null-prototype
 * object, a throwing `toString` or getter) maps to `UnrepresentableThrown` instead of
 * throwing, so the transport race always settles (WP-06 review round 1).
 *
 * @example
 * transportErrorFromThrown(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
 * // { kind: 'transport_error', error_name: 'TimeoutError', message: 'socket hang up' }
 */
export function transportErrorFromThrown(thrown: unknown): ProviderTransportError {
  try {
    if (thrown instanceof Error) {
      // Typed string, but a hostile Error can carry any value there, or a throwing getter.
      const { name, message } = thrown as { readonly name: unknown; readonly message: unknown };
      return { kind: 'transport_error', error_name: String(name), message: String(message) };
    }
    return { kind: 'transport_error', error_name: 'NonErrorThrown', message: String(thrown) };
  } catch {
    return {
      kind: 'transport_error',
      error_name: UNREPRESENTABLE_THROWN_NAME,
      message: 'the thrown value has no readable name or string form',
    };
  }
}
