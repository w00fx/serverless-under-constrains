// Transport settlement classification (design §9.9; BR-RUA-021, BR-RUA-053 "both transport-level
// and function-level errors are parsed explicitly"). It runs only when the transport won the
// arbiter; a settlement after a timer win is recorded and never parsed (D-26). Every row other
// than a well-formed SUCCEEDED or REJECTED payload is `FAILED` with the attempt `DISPATCHED`,
// which is ambiguous, so effect knowledge becomes `UNKNOWN` (BR-RUA-004).
//
// | Settlement                                                        | Result                     |
// |-------------------------------------------------------------------|----------------------------|
// | response, no function error, version and ids echo, SUCCEEDED      | succeeded                  |
// | the same with REJECTED                                            | rejected                   |
// | response with a non-empty function error (raw value kept)         | FUNCTION_ERROR             |
// | executed version mismatched or absent                             | VERSION_MISMATCH           |
// | status other than 200, unparseable payload, or ids not echoed     | MALFORMED_RESPONSE         |
// | AbortError without a timer win                                    | ABORTED_WITHOUT_DEADLINE   |
// | any other transport error (throttle, not found, 5xx, network)     | TRANSPORT_ERROR            |

import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { ProviderRefundResponse } from '../record-contract/records/group-a/provider_refund_response.ts';
import type { ProviderRejectionReason } from '../record-contract/records/group-b/vocabulary.ts';
import type { ProviderResponseSettlement, ProviderTransportResult } from './provider-invocation-port.ts';
import { ABORT_ERROR_NAME } from './provider-invocation-port.ts';
import { readProviderRefundResponse } from './provider-response-guard.ts';

/** The status of a successful `RequestResponse` invocation (Lambda Invoke API, `StatusCode`). */
export const REQUEST_RESPONSE_STATUS = 200;

/** What the response of one attempt must echo. */
export interface ExpectedProviderResponse {
  /** The provider version the attempt invoked; `ExecutedVersion` must equal it. */
  readonly qualifier: string;
  readonly attempt_id: Uuid4;
  readonly provider_request_id: Uuid4;
}

export type ResponseFailureCode =
  'FUNCTION_ERROR' | 'VERSION_MISMATCH' | 'MALFORMED_RESPONSE' | 'ABORTED_WITHOUT_DEADLINE' | 'TRANSPORT_ERROR';

/** Diagnostics a response carried, kept on the outcome record. */
export interface ResponseDiagnostics {
  readonly executed_version?: string;
  readonly function_error?: string;
}

export type ParsedProviderResponse =
  | (ResponseDiagnostics & {
      readonly kind: 'succeeded';
      readonly provider_call_id: Uuid4;
      readonly provider_transaction_id: Uuid4;
    })
  | (ResponseDiagnostics & {
      readonly kind: 'rejected';
      readonly provider_call_id: Uuid4;
      readonly rejection_reason: ProviderRejectionReason;
    })
  | (ResponseDiagnostics & {
      readonly kind: 'failed';
      readonly failure: StructuredReason & { readonly code: ResponseFailureCode };
    });

/**
 * Classifies the settlement that won the arbiter (design §9.9).
 *
 * @example
 * parseProviderResponse({ kind: 'transport_error', error_name: 'AbortError', message: 'Request aborted' }, expected);
 * // { kind: 'failed', failure: { code: 'ABORTED_WITHOUT_DEADLINE', ... } }
 */
export function parseProviderResponse(
  result: ProviderTransportResult,
  expected: ExpectedProviderResponse,
): ParsedProviderResponse {
  if (result.kind === 'transport_error') {
    return classifyTransportError(result.error_name, result.message, result.http_status);
  }
  const diagnostics = diagnosticsOf(result);
  if (result.function_error !== undefined && result.function_error !== '') {
    return failed(
      'FUNCTION_ERROR',
      'BR-RUA-053',
      `function error ${JSON.stringify(result.function_error)}; expected none`,
      diagnostics,
    );
  }
  if (result.executed_version !== expected.qualifier) {
    return failed(
      'VERSION_MISMATCH',
      'BR-RUA-053',
      `executed version ${JSON.stringify(result.executed_version)}; expected the invoked version ${JSON.stringify(expected.qualifier)}`,
      diagnostics,
    );
  }
  return classifyPayload(result, expected, diagnostics);
}

function classifyTransportError(
  errorName: string,
  message: string,
  httpStatus: number | undefined,
): ParsedProviderResponse {
  if (errorName === ABORT_ERROR_NAME) {
    return failed(
      'ABORTED_WITHOUT_DEADLINE',
      'BR-RUA-023',
      `transport aborted (${message}) without a deadline timer win; expected an abort only after the timer won`,
    );
  }
  const status = httpStatus === undefined ? '' : ` (HTTP ${String(httpStatus)})`;
  return failed(
    'TRANSPORT_ERROR',
    'BR-RUA-053',
    `transport_error:${errorName}${status}: ${message}; expected a provider response`,
  );
}

function classifyPayload(
  result: ProviderResponseSettlement,
  expected: ExpectedProviderResponse,
  diagnostics: ResponseDiagnostics,
): ParsedProviderResponse {
  if (result.status_code !== REQUEST_RESPONSE_STATUS) {
    return malformed(`status ${String(result.status_code)}; expected ${String(REQUEST_RESPONSE_STATUS)}`, diagnostics);
  }
  const parsed = parseJsonDocument(result.payload);
  if (!parsed.ok) {
    return malformed(`payload is not a JSON document (${JSON.stringify(parsed.error)})`, diagnostics);
  }
  const response = readProviderRefundResponse(parsed.value);
  if (!response.ok) {
    return malformed(response.error, diagnostics);
  }
  const echoProblem = echoMismatch(response.value, expected);
  if (echoProblem !== undefined) {
    return malformed(echoProblem, diagnostics);
  }
  if (response.value.outcome === 'SUCCEEDED') {
    const { provider_call_id, provider_transaction_id } = response.value;
    return { ...diagnostics, kind: 'succeeded', provider_call_id, provider_transaction_id };
  }
  const { provider_call_id, rejection_reason } = response.value;
  return { ...diagnostics, kind: 'rejected', provider_call_id, rejection_reason };
}

// The call always carries valid lowercase UUIDv4 identities, so the provider echoes both of
// them in every response, a rejection included.
function echoMismatch(response: ProviderRefundResponse, expected: ExpectedProviderResponse): string | undefined {
  for (const field of ['attempt_id', 'provider_request_id'] as const) {
    if (response[field] !== expected[field]) {
      return `${field} ${JSON.stringify(response[field])}; expected the request's ${expected[field]}`;
    }
  }
  return undefined;
}

function diagnosticsOf(result: ProviderResponseSettlement): ResponseDiagnostics {
  return {
    ...(result.executed_version === undefined || result.executed_version === ''
      ? {}
      : { executed_version: result.executed_version }),
    ...(result.function_error === undefined || result.function_error === ''
      ? {}
      : { function_error: result.function_error }),
  };
}

function malformed(detail: string, diagnostics: ResponseDiagnostics): ParsedProviderResponse {
  return failed('MALFORMED_RESPONSE', 'BR-RUA-018', detail, diagnostics);
}

function failed(
  code: ResponseFailureCode,
  subject: string,
  detail: string,
  diagnostics: ResponseDiagnostics = {},
): ParsedProviderResponse {
  return { ...diagnostics, kind: 'failed', failure: { code, subject, detail } };
}
