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

/** The error name of a port that resolved something other than a `ProviderTransportResult`. */
export const MALFORMED_PORT_RESULT_NAME = 'MalformedPortResult';

/**
 * The settlement a port resolved, copied field by field when it has the shape of a
 * `ProviderTransportResult`; otherwise a transport error named MALFORMED_PORT_RESULT_NAME that
 * says what was resolved. A defective port that resolves `undefined`, a string or an object with
 * mistyped fields (or with throwing getters) still settles the attempt after the dispatch
 * boundary instead of making the classification throw (WP-06 review round 2). Each field is
 * read once, so a getter cannot change a value between this check and its later use.
 *
 * @example
 * transportResultOf(undefined);
 * // { kind: 'transport_error', error_name: 'MalformedPortResult', message: 'the provider invocation port resolved undefined; ...' }
 */
export function transportResultOf(value: unknown): ProviderTransportResult {
  try {
    const result = responseSettlementOf(value) ?? transportErrorOf(value);
    if (result !== undefined) {
      return result;
    }
  } catch {
    // A throwing getter is no better formed than a missing field: the value falls through to
    // the malformed-result error below, which the attempt records as its outcome.
  }
  return {
    kind: 'transport_error',
    error_name: MALFORMED_PORT_RESULT_NAME,
    message: `the provider invocation port resolved ${typeNameOf(value)}; expected a ProviderTransportResult (kind "response" or "transport_error" with typed fields)`,
  };
}

// `typeof` never throws, not even for a revoked proxy, so the message is total.
function typeNameOf(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function responseSettlementOf(value: unknown): ProviderResponseSettlement | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const fields = value as Partial<Record<keyof ProviderResponseSettlement, unknown>>;
  const { kind, status_code, executed_version, function_error, payload } = fields;
  const wellTyped =
    kind === 'response' &&
    typeof status_code === 'number' &&
    isOptionalString(executed_version) &&
    isOptionalString(function_error) &&
    payload instanceof Uint8Array;
  return wellTyped ? { kind, status_code, executed_version, function_error, payload } : undefined;
}

function transportErrorOf(value: unknown): ProviderTransportError | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const fields = value as Partial<Record<keyof ProviderTransportError, unknown>>;
  const { kind, error_name, message, http_status } = fields;
  if (kind !== 'transport_error' || typeof error_name !== 'string' || typeof message !== 'string') {
    return undefined;
  }
  if (http_status === undefined) {
    return { kind, error_name, message };
  }
  return typeof http_status === 'number' ? { kind, error_name, message, http_status } : undefined;
}
