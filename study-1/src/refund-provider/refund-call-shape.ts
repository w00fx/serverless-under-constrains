// The hand-written guard of a `provider_refund_call` (BR-RUA-018, design §9.10). The provider
// runs no Ajv, so nothing compiles at cold start (RK-01). The schema at
// `schemas/group-a/provider_refund_call.schema.json` is split across three acceptance checks so
// each condition of §9.10 keeps its own rejection reason:
// - check 2 `guardRefundCallShape`: the structure (closed property set, constants, caller enum,
//   exactly one execution identity, the probe/trial branches, identity and digest patterns of
//   the execution, the currency pattern, and the JSON type of every required field);
// - check 4 `identityStructureViolation`: the attempt identities are lowercase UUIDv4 and the
//   business identities are non-empty after trimming;
// - check 6 `amountViolation`: the amount is a safe integer of at least 1.
// The three together accept exactly what the schema accepts; the differential property in
// `test/fuzz/refund-provider/` holds them to Ajv.

import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { isJsonObject } from '../record-contract/json-value.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  JsonValue,
  Result,
  Sha256Hex,
  Uuid4,
} from '../record-contract/primitives.ts';
import type { ProviderCallerId } from '../record-contract/records/group-a/provider_refund_call.ts';
import { PROVIDER_CALLER_IDS } from '../record-contract/records/group-a/provider_refund_call.ts';
import { parseExecutionIdentityFields } from './execution-identity-fields.ts';
import { describeUntrusted, excerptUntrusted } from './untrusted-json.ts';

/** Every property the call schema declares; any other property makes the call schema-invalid. */
export const REFUND_CALL_PROPERTIES = [
  'schema_version',
  'record_type',
  'caller_id',
  'run_id',
  'variant_validation_id',
  'transport_probe_id',
  'execution_manifest_sha256',
  'trial_id',
  'trial_manifest_sha256',
  'attempt_id',
  'provider_request_id',
  'refund_request_id',
  'payment_id',
  'amount_minor',
  'currency',
] as const;

/** `_defs.schema.json#/$defs/nonempty_trimmed`, with the `u` flag Ajv compiles patterns with. */
export const NONEMPTY_TRIMMED_PATTERN = /^\S(.*\S)?$/u;
/** The call schema's ISO 4217-shaped currency pattern. */
export const CURRENCY_PATTERN = /^[A-Z]{3}$/u;

const STRING_FIELDS = ['attempt_id', 'provider_request_id', 'refund_request_id', 'payment_id'] as const;

/** The trial a trial-scoped call names. */
export interface CallTrial {
  readonly trial_id: Uuid4;
  readonly trial_manifest_sha256: Sha256Hex;
}

/** A call whose structure matches the schema; its identities and amount are not judged yet. */
export interface RefundCallShape {
  readonly caller_id: ProviderCallerId;
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  /** Absent exactly for a transport-probe call (D-06). */
  readonly trial?: CallTrial;
  readonly attempt_id: string;
  readonly provider_request_id: string;
  readonly refund_request_id: string;
  readonly payment_id: string;
  readonly amount_minor: number;
  readonly currency: string;
}

/**
 * Check 2 of design §9.10: the call's structure. The failure names the first offending
 * property, its value and the expected shape.
 *
 * @example
 * const shape = guardRefundCallShape(raw);
 * if (!shape.ok) return reject('SCHEMA_INVALID', shape.error);
 */
export function guardRefundCallShape(raw: JsonValue): Result<RefundCallShape, string> {
  if (!isJsonObject(raw)) {
    return failure(`call is ${describeUntrusted(raw)}; expected a provider_refund_call JSON object`);
  }
  const problem = envelopeProblem(raw) ?? businessFieldProblem(raw);
  if (problem !== undefined) {
    return failure(problem);
  }
  const execution = parseExecutionIdentityFields(raw);
  if (!execution.ok) {
    return execution;
  }
  const trial = trialOf(raw, execution.value);
  if (!trial.ok) {
    return trial;
  }
  return { ok: true, value: shapeOf(raw, execution.value, trial.value) };
}

/**
 * Check 4 of design §9.10: `attempt_id` and `provider_request_id` are lowercase UUIDv4, and
 * `refund_request_id` and `payment_id` are non-empty after trimming.
 *
 * @example
 * identityStructureViolation({ ...shape, attempt_id: 'ABC' }); // 'attempt_id "ABC"; expected ...'
 */
export function identityStructureViolation(shape: RefundCallShape): string | undefined {
  for (const field of ['attempt_id', 'provider_request_id'] as const) {
    if (!isUuid4(shape[field])) {
      return `${field} ${excerptUntrusted(shape[field])}; expected a lowercase RFC 4122 version-4 UUID`;
    }
  }
  for (const field of ['refund_request_id', 'payment_id'] as const) {
    if (!NONEMPTY_TRIMMED_PATTERN.test(shape[field])) {
      return `${field} ${excerptUntrusted(shape[field])}; expected a string that is non-empty after trimming`;
    }
  }
  return undefined;
}

/**
 * Check 6 of design §9.10: the amount is a positive safe integer (BR-RUA-018).
 *
 * @example
 * amountViolation({ ...shape, amount_minor: 0 }); // 'amount_minor 0; expected a safe integer >= 1'
 */
export function amountViolation(shape: RefundCallShape): string | undefined {
  if (Number.isSafeInteger(shape.amount_minor) && shape.amount_minor >= 1) {
    return undefined;
  }
  return `amount_minor ${String(shape.amount_minor)}; expected a safe integer >= 1 (at most ${String(Number.MAX_SAFE_INTEGER)})`;
}

function envelopeProblem(raw: JsonObject): string | undefined {
  const unknown = Object.keys(raw).find((key) => !(REFUND_CALL_PROPERTIES as readonly string[]).includes(key));
  if (unknown !== undefined) {
    return `property ${excerptUntrusted(unknown)} is not part of provider_refund_call; expected only ${REFUND_CALL_PROPERTIES.join(', ')}`;
  }
  if (raw['schema_version'] !== 1) {
    return `schema_version is ${describeUntrusted(raw['schema_version'])}; expected the number 1`;
  }
  if (raw['record_type'] !== 'provider_refund_call') {
    return `record_type is ${describeUntrusted(raw['record_type'])}; expected "provider_refund_call"`;
  }
  if (!(PROVIDER_CALLER_IDS as readonly JsonValue[]).includes(raw['caller_id'] ?? null)) {
    return `caller_id is ${describeUntrusted(raw['caller_id'])}; expected one of ${PROVIDER_CALLER_IDS.join(', ')}`;
  }
  if (!isSha256Hex(raw['execution_manifest_sha256'])) {
    return `execution_manifest_sha256 is ${describeUntrusted(raw['execution_manifest_sha256'])}; expected 64 lowercase hex digits`;
  }
  return undefined;
}

function businessFieldProblem(raw: JsonObject): string | undefined {
  const missing = STRING_FIELDS.find((field) => typeof raw[field] !== 'string');
  if (missing !== undefined) {
    return `${missing} is ${describeUntrusted(raw[missing])}; expected a string`;
  }
  if (typeof raw['amount_minor'] !== 'number') {
    return `amount_minor is ${describeUntrusted(raw['amount_minor'])}; expected a JSON number`;
  }
  const currency = raw['currency'];
  if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
    return `currency is ${describeUntrusted(currency)}; expected three uppercase ASCII letters`;
  }
  return undefined;
}

function trialOf(raw: JsonObject, execution: ExecutionIdentity): Result<CallTrial | undefined, string> {
  if (execution.execution_kind === 'TRANSPORT_PROBE') {
    return probeBranch(raw);
  }
  if (raw['caller_id'] === 'probe') {
    return failure(`caller_id "probe" on a ${execution.execution_kind} call; expected conventional or durable`);
  }
  const trialId = raw['trial_id'];
  if (!isUuid4(trialId)) {
    return failure(`trial_id is ${describeUntrusted(trialId)}; expected a lowercase RFC 4122 version-4 UUID`);
  }
  const digest = raw['trial_manifest_sha256'];
  if (!isSha256Hex(digest)) {
    return failure(`trial_manifest_sha256 is ${describeUntrusted(digest)}; expected 64 lowercase hex digits`);
  }
  return { ok: true, value: { trial_id: trialId, trial_manifest_sha256: digest } };
}

function probeBranch(raw: JsonObject): Result<undefined, string> {
  if (raw['caller_id'] !== 'probe') {
    return failure(`caller_id is ${describeUntrusted(raw['caller_id'])} on a transport-probe call; expected "probe"`);
  }
  const trialField = (['trial_id', 'trial_manifest_sha256'] as const).find((field) => Object.hasOwn(raw, field));
  if (trialField !== undefined) {
    return failure(`${trialField} is present on a transport-probe call; expected no trial identity (D-06)`);
  }
  return { ok: true, value: undefined };
}

function shapeOf(raw: JsonObject, execution: ExecutionIdentity, trial: CallTrial | undefined): RefundCallShape {
  // The guards above proved every type; the casts only restate what they checked.
  const common = {
    caller_id: raw['caller_id'] as ProviderCallerId,
    execution,
    execution_manifest_sha256: raw['execution_manifest_sha256'] as Sha256Hex,
    attempt_id: raw['attempt_id'] as string,
    provider_request_id: raw['provider_request_id'] as string,
    refund_request_id: raw['refund_request_id'] as string,
    payment_id: raw['payment_id'] as string,
    amount_minor: raw['amount_minor'] as number,
    currency: raw['currency'] as string,
  };
  return trial === undefined ? common : { ...common, trial };
}

function failure(detail: string): { readonly ok: false; readonly error: string } {
  return { ok: false, error: detail };
}
