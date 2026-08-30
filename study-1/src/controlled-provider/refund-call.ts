import {
  fail,
  isPositiveSafeInteger,
  isRecord,
  isSha256Hex,
  isUuidV4,
  ok,
  ownKeys,
  REJECTED_ALIASES,
  trimmedIdentity,
} from "../protocol-records/primitives.ts";
import type { ValidationResult } from "../protocol-records/types.ts";
import type { ExecutionBindingKey, RefundCall } from "./types.ts";

const CALL_KEYS = new Set([
  "schema_version",
  "record_type",
  "run_id",
  "transport_probe_id",
  "variant_validation_id",
  "trial_id",
  "trial_manifest_sha256",
  "attempt_id",
  "provider_request_id",
  "payment_id",
  "refund_request_id",
  "amount_minor",
  "currency",
]);

const BINDING_KEYS: readonly ExecutionBindingKey[] = [
  "run_id",
  "transport_probe_id",
  "variant_validation_id",
];

// `createRefundCall` rejects a call carrying zero or several bindings, so every
// parsed call resolves to exactly one key here.
export function bindingKeyOf(value: Pick<RefundCall, ExecutionBindingKey>): ExecutionBindingKey {
  return BINDING_KEYS.find((key) => value[key] !== undefined)!;
}

function identityReason(value: unknown): string {
  return typeof value === "string" ? "empty_identity" : "invalid_identifier";
}

function collectReasons(input: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const unexpected = ownKeys(input).filter((key) => !CALL_KEYS.has(key));
  for (const key of unexpected) {
    reasons.push(REJECTED_ALIASES.includes(key) ? "alias_rejected" : "unknown_property");
  }
  if (input.schema_version !== 1) {
    reasons.push("invalid_schema_version");
  }
  if (input.record_type !== "refund_call") {
    reasons.push("invalid_record_type");
  }
  const present = BINDING_KEYS.flatMap((key) => (input[key] === undefined ? [] : [key]));
  if (present.length === 0) {
    reasons.push("missing_execution_binding");
  } else if (present.length > 1) {
    reasons.push("ambiguous_execution_binding");
  } else if (!isUuidV4(input[present[0]!])) {
    reasons.push("invalid_uuid");
  }
  for (const field of ["trial_id", "attempt_id", "provider_request_id"] as const) {
    if (!isUuidV4(input[field])) {
      reasons.push("invalid_uuid");
    }
  }
  if (!isSha256Hex(input.trial_manifest_sha256)) {
    reasons.push("invalid_sha256");
  }
  if (trimmedIdentity(input.payment_id) === undefined) {
    reasons.push(identityReason(input.payment_id));
  }
  if (trimmedIdentity(input.refund_request_id) === undefined) {
    reasons.push(identityReason(input.refund_request_id));
  }
  if (!isPositiveSafeInteger(input.amount_minor)) {
    reasons.push("invalid_amount");
  }
  if (input.currency !== "BRL") {
    reasons.push("invalid_currency");
  }
  return reasons;
}

export function createRefundCall(input: unknown): ValidationResult<RefundCall> {
  if (!isRecord(input)) {
    return fail(["not_an_object"]);
  }
  const reasons = collectReasons(input);
  if (reasons.length > 0) {
    return fail(reasons);
  }
  const present = BINDING_KEYS.flatMap((key) => (input[key] === undefined ? [] : [key]));
  const call: RefundCall = {
    schema_version: 1,
    record_type: "refund_call",
    trial_id: input.trial_id as string,
    trial_manifest_sha256: input.trial_manifest_sha256 as string,
    attempt_id: input.attempt_id as string,
    provider_request_id: input.provider_request_id as string,
    payment_id: trimmedIdentity(input.payment_id) as string,
    refund_request_id: trimmedIdentity(input.refund_request_id) as string,
    amount_minor: input.amount_minor as number,
    currency: "BRL",
  };
  call[present[0]!] = input[present[0]!] as string;
  return ok(call);
}
