// The runner's provider warm-up before a trial publication (addendum §2, D-27 resolution): one
// synchronous Invoke of the provider's published version with a `provider_warmup_request` that
// names the trial about to start as a correlation field only. The provider journals
// `provider_warmup_completed` in `<execution_id>#warmup` and returns that event. Anything else (a
// transport error, a function error, another version, a payload that is not the completion of
// this warm-up) is a failed or ambiguous warm-up, which stops the trial before publication: a
// pre-publication setup rejection, no trial started.
//
// The response payload is untrusted bytes: it is parsed strictly and checked against the
// `provider_warmup_completed` schema before any field is read (A-05: reject, never throw).

import type { ProviderTransportResult } from '../provider-client/provider-invocation-port.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonObject, JsonValue, StructuredReason, UuidSource } from '../record-contract/primitives.ts';
import type { ProviderWarmupCompleted } from '../record-contract/records/group-b/provider_warmup_completed.ts';
import type { ProviderWarmupRequest } from '../record-contract/records/group-b/provider_warmup_request.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { ProviderWarmupInvoker, TrialPlan } from './trial-execution-ports.ts';

const SUBJECT = 'addendum §2';
const INVOKE_OK = 200;

/**
 * The warm-up request of the trial about to start, with a fresh `warmup_id`.
 *
 * @example
 * warmupRequestOf(plan, ids).record_type; // 'provider_warmup_request'
 */
export function warmupRequestOf(plan: TrialPlan, ids: UuidSource): ProviderWarmupRequest {
  return {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    ...executionIdentityFields(plan.execution),
    execution_manifest_sha256: plan.execution_manifest_sha256,
    warmup_id: ids.next(),
    trial_id: plan.trial.trial_id,
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
 * Warms the provider once for the trial (addendum §2.1); `undefined` when the provider completed
 * this warm-up, otherwise the setup rejection.
 *
 * @example
 * const rejection = await warmUpProvider(invoker, plan, ids, validator);
 * if (rejection !== undefined) return notStarted([rejection]);
 */
export async function warmUpProvider(
  invoker: ProviderWarmupInvoker,
  plan: TrialPlan,
  ids: UuidSource,
  validator: RecordValidator,
): Promise<StructuredReason | undefined> {
  const request = warmupRequestOf(plan, ids);
  const settlement = await invoker.invokeWarmup(request);
  return warmupSettlementProblem(settlement, request, plan.provider_version, validator);
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
