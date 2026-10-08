// The runner's provider warm-up before a trial publication (addendum §2, D-27 resolution): one
// synchronous Invoke of the provider's published version with a `provider_warmup_request` that
// names the trial about to start as a correlation field only. The provider journals
// `provider_warmup_completed` in `<execution_id>#warmup` and returns that event. Anything else (a
// transport error, a function error, another version, a payload that is not the completion of
// this warm-up) is a failed or ambiguous warm-up, which stops the trial before publication: a
// pre-publication setup rejection, no trial started. The transport probe performs the same single
// warm-up before its one caller invocation (addendum §2.1); its request names no trial (D-06).
//
// The response payload is untrusted bytes: it is parsed strictly and checked against the
// `provider_warmup_completed` schema before any field is read (A-05: reject, never throw).

import { ownValue } from '../evidence-collection/sdk-values.ts';
import { transportErrorFromThrown } from '../provider-client/provider-invocation-port.ts';
import type {
  ProviderResponseSettlement,
  ProviderTransportError,
  ProviderTransportResult,
} from '../provider-client/provider-invocation-port.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  JsonValue,
  Sha256Hex,
  StructuredReason,
  UuidSource,
  Uuid4,
} from '../record-contract/primitives.ts';
import type { ProviderWarmupCompleted } from '../record-contract/records/group-b/provider_warmup_completed.ts';
import type { ProviderWarmupRequest } from '../record-contract/records/group-b/provider_warmup_request.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { lambdaInvokeResponseOf } from './probe-invocation.ts';
import type { ProviderWarmupInvoker } from './trial-execution-ports.ts';

const SUBJECT = 'addendum §2';
const INVOKE_OK = 200;

/**
 * What a warm-up is for: the execution, its manifest digest, the provider version the warm-up must
 * report as executed and, for a trial, the trial about to start. A TrialPlan is one; the probe's
 * plan has no `trial`.
 */
export interface WarmupSubject {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly provider_version: string;
  readonly trial?: { readonly trial_id: Uuid4 };
}

/**
 * The warm-up request of the trial about to start (or of the probe), with a fresh `warmup_id`.
 *
 * @example
 * warmupRequestOf(plan, ids).record_type; // 'provider_warmup_request'
 */
export function warmupRequestOf(subject: WarmupSubject, ids: UuidSource): ProviderWarmupRequest {
  return {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    ...executionIdentityFields(subject.execution),
    execution_manifest_sha256: subject.execution_manifest_sha256,
    warmup_id: ids.next(),
    ...(subject.trial === undefined ? {} : { trial_id: subject.trial.trial_id }),
  };
}

/**
 * Why a warm-up settlement is not the provider's completion of `request` at `version`;
 * `undefined` when it is. Total over any settlement and payload bytes.
 *
 * @example
 * warmupSettlementProblem(settlement, request, '1', validator); // undefined for a completed warm-up
 */
export function warmupSettlementProblem(
  settlement: ProviderTransportResult,
  request: ProviderWarmupRequest,
  version: string,
  validator: RecordValidator,
): StructuredReason | undefined {
  if (settlement.kind === 'transport_error') {
    return failed(`the Invoke failed with ${boundedText(settlement.error_name)}: ${boundedText(settlement.message)}`);
  }
  if (settlement.status_code !== INVOKE_OK || settlement.function_error !== undefined) {
    return failed(
      `the Invoke returned status ${String(settlement.status_code)} with function error ${boundedText(String(settlement.function_error))}`,
    );
  }
  if (settlement.executed_version !== version) {
    return failed(`the Invoke executed version ${boundedText(String(settlement.executed_version))}, not ${version}`);
  }
  return completionProblem(settlement.payload, request, validator);
}

/**
 * Warms the provider once for the trial or the probe (addendum §2.1); `undefined` when the
 * provider completed this warm-up, otherwise the setup rejection.
 *
 * @example
 * const rejection = await warmUpProvider(invoker, plan, ids, validator);
 * if (rejection !== undefined) return notStarted([rejection]);
 */
export async function warmUpProvider(
  invoker: ProviderWarmupInvoker,
  subject: WarmupSubject,
  ids: UuidSource,
  validator: RecordValidator,
): Promise<StructuredReason | undefined> {
  const request = warmupRequestOf(subject, ids);
  const settlement = await invoker.invokeWarmup(request);
  return warmupSettlementProblem(settlement, request, subject.provider_version, validator);
}

/**
 * The settlement of a warm-up Invoke that returned, read from the SDK output member by member
 * (A-05): the same `response` the provider client's invoker settles with.
 *
 * @example
 * warmupResponseOf({ StatusCode: 200, ExecutedVersion: '1', Payload: bytes }).status_code; // 200
 */
export function warmupResponseOf(output: unknown): ProviderResponseSettlement {
  const response = lambdaInvokeResponseOf(output);
  return {
    kind: 'response',
    status_code: response.status_code,
    executed_version: response.executed_version,
    function_error: response.function_error,
    payload: response.payload,
  };
}

/**
 * The settlement of a warm-up Invoke that threw: a transport error named after what was thrown,
 * with the HTTP status of a service exception. Any transport error fails the warm-up.
 *
 * @example
 * warmupTransportErrorOf(new Error('socket hang up')); // { kind: 'transport_error', error_name: 'Error', message: 'socket hang up' }
 */
export function warmupTransportErrorOf(thrown: unknown): ProviderTransportError {
  const error = transportErrorFromThrown(thrown);
  try {
    const status = ownValue(ownValue(thrown, '$metadata'), 'httpStatusCode');
    return typeof status === 'number' ? { ...error, http_status: status } : error;
  } catch {
    return error;
  }
}

function completionProblem(
  payload: Uint8Array,
  request: ProviderWarmupRequest,
  validator: RecordValidator,
): StructuredReason | undefined {
  const parsed = parseJsonDocument(payload);
  if (!parsed.ok) {
    return failed(`the response payload is not one JSON document (${parsed.error.kind})`);
  }
  const checked = validator.validateAs('provider_warmup_completed', parsed.value);
  if (!checked.valid) {
    const violations = checked.violations
      .map((violation) => `${violation.instance_path} ${violation.detail}`)
      .join('; ');
    return failed(`the response is not a provider_warmup_completed (${boundedText(violations)})`);
  }
  const completed = checked.record as ProviderWarmupCompleted;
  const mismatch = correlationMismatch(completed, request);
  return mismatch === undefined ? undefined : failed(mismatch);
}

// The completion must name exactly the request's warm-up and execution: the same identity field
// with the same id (a missing or extra identity field is a mismatch too) and the same digest.
const CORRELATED_FIELDS = [
  'warmup_id',
  'execution_manifest_sha256',
  'run_id',
  'variant_validation_id',
  'transport_probe_id',
] as const;

function correlationMismatch(completed: ProviderWarmupCompleted, request: ProviderWarmupRequest): string | undefined {
  const got = completed as unknown as JsonObject;
  const want = request as unknown as JsonObject;
  const field = CORRELATED_FIELDS.find((name) => ownField(got, name) !== ownField(want, name));
  if (field === undefined) {
    return undefined;
  }
  return `the completion names ${field} ${describeField(ownField(got, field))}, not ${describeField(ownField(want, field))}`;
}

// Correlated values are schema-validated identifiers and digests; an absent one reads as such.
// They are quoted through the kernel's bounded renderer, never a local JSON.stringify (A-05).
function describeField(value: JsonValue | undefined): string {
  return value === undefined ? 'absent' : boundedJsonText(value);
}

function ownField(record: JsonObject, name: string): JsonValue | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

function failed(problem: string): StructuredReason {
  return {
    code: 'PROVIDER_WARMUP_FAILED',
    subject: SUBJECT,
    detail: `${problem}; expected the provider's provider_warmup_completed of this warm-up`,
  };
}
