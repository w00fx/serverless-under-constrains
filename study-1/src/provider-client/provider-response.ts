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
// | response with a non-empty function error (raw value kept, bounded)| FUNCTION_ERROR             |
// | executed version mismatched or absent                             | VERSION_MISMATCH           |
// | status other than 200, unparseable payload, or ids not echoed     | MALFORMED_RESPONSE         |
// | AbortError without a timer win                                    | ABORTED_WITHOUT_DEADLINE   |
// | any other transport error (throttle, not found, 5xx, network)     | TRANSPORT_ERROR            |
//
// The classification is total: every settlement, whatever its bytes, headers or error text,
// yields a result and never a throw, because it runs after the dispatch boundary and the
// attempt must still record its outcome. Every untrusted value that reaches the outcome event
// is bounded, so the event always fits the 400 KB item limit (aws-semantics.md) and
// `attempt_outcome_recorded` is stored for every dispatched attempt (BR-RUA-021):
// - a failure detail quotes untrusted values only through the kernel renderings
//   `describeJson` and `boundedJsonText` (Owner amendment A-05.1);
// - the `function_error` and `executed_version` diagnostics keep the raw header value verbatim
//   up to RESPONSE_DIAGNOSTIC_MAX_CHARS characters (design §9.9, U-4: the value set is
//   UNVERIFIED, so the value is never normalized); a longer, hostile value is cut there and
//   names its original length (WP-06 review round 2: a 500,000-character function error made
//   the outcome put fail with ValidationException, so the dispatched attempt lost its outcome).

import { boundedJsonText, describeJson } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonParseFailure } from '../record-contract/parsing.ts';
import type { StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { ProviderRefundResponse } from '../record-contract/records/group-a/provider_refund_response.ts';
import type { ProviderRejectionReason } from '../record-contract/records/group-b/vocabulary.ts';
import type { ProviderResponseSettlement, ProviderTransportResult } from './provider-invocation-port.ts';
import { ABORT_ERROR_NAME } from './provider-invocation-port.ts';
import { readProviderRefundResponse } from './provider-response-guard.ts';

/** The status of a successful `RequestResponse` invocation (Lambda Invoke API, `StatusCode`). */
export const REQUEST_RESPONSE_STATUS = 200;

/**
 * The most characters of a response diagnostic the outcome record keeps verbatim. Real values
 * are a few characters (`Unhandled`, a version number), so only a hostile value is ever cut.
 */
export const RESPONSE_DIAGNOSTIC_MAX_CHARS = 1024;

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

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
      `function error ${describeJson(result.function_error)}; expected none`,
      diagnostics,
    );
  }
  if (result.executed_version !== expected.qualifier) {
    return failed(
      'VERSION_MISMATCH',
      'BR-RUA-053',
      `executed version ${describeJson(result.executed_version)}; expected the invoked version ${describeJson(expected.qualifier)}`,
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
      `transport aborted (${boundedJsonText(message)}) without a deadline timer win; expected an abort only after the timer won`,
    );
  }
  const status = httpStatus === undefined ? '' : ` (HTTP ${String(httpStatus)})`;
  return failed(
    'TRANSPORT_ERROR',
    'BR-RUA-053',
    `transport_error:${boundedJsonText(errorName)}${status}: ${boundedJsonText(message)}; expected a provider response`,
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
    return malformed(`payload is not a JSON document (${describeParseFailure(parsed.error)})`, diagnostics);
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
      return `${field} ${describeJson(response[field])}; expected the request's ${expected[field]}`;
    }
  }
  return undefined;
}

function describeParseFailure(failure: JsonParseFailure): string {
  return failure.kind === 'invalid_utf8'
    ? `invalid UTF-8 at byte ${String(failure.byte_offset)}`
    : `invalid JSON: ${boundedJsonText(failure.detail)}`;
}

function diagnosticsOf(result: ProviderResponseSettlement): ResponseDiagnostics {
  return {
    ...(result.executed_version === undefined || result.executed_version === ''
      ? {}
      : { executed_version: boundedDiagnostic(result.executed_version) }),
    ...(result.function_error === undefined || result.function_error === ''
      ? {}
      : { function_error: boundedDiagnostic(result.function_error) }),
  };
}

/**
 * A raw diagnostic header value as the outcome record keeps it: the value itself when it has
 * at most RESPONSE_DIAGNOSTIC_MAX_CHARS characters; otherwise its first
 * RESPONSE_DIAGNOSTIC_MAX_CHARS characters (one fewer when the cut would split a surrogate
 * pair) followed by `…[truncated from <length> chars]`.
 *
 * @example
 * boundedDiagnostic('Unhandled'); // 'Unhandled'
 * boundedDiagnostic('E'.repeat(2000)); // 1024 E, then '…[truncated from 2000 chars]'
 */
export function boundedDiagnostic(value: string): string {
  if (value.length <= RESPONSE_DIAGNOSTIC_MAX_CHARS) {
    return value;
  }
  const lastKept = value.charCodeAt(RESPONSE_DIAGNOSTIC_MAX_CHARS - 1);
  const splitsPair = lastKept >= HIGH_SURROGATE_MIN && lastKept <= HIGH_SURROGATE_MAX;
  const end = splitsPair ? RESPONSE_DIAGNOSTIC_MAX_CHARS - 1 : RESPONSE_DIAGNOSTIC_MAX_CHARS;
  return `${value.slice(0, end)}…[truncated from ${String(value.length)} chars]`;
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
