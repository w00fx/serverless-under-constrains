import { randomUUID } from "node:crypto";
import type { ValidationResult } from "../protocol-records/types.ts";
import { fail, isRecord, isUuidV4, ok, trimmedIdentity } from "../protocol-records/primitives.ts";
import type { AttemptIdentities } from "./types.ts";

function optionalUuidOrMint(value: unknown): ValidationResult<string> {
  if (value === undefined) {
    return ok(randomUUID());
  }
  if (!isUuidV4(value)) {
    return fail(["invalid_uuid"]);
  }
  return ok(value);
}

/**
 * Mint a fresh physical attempt and provider-request identity while keeping
 * the logical refund request identity.
 *
 * @example
 * createAttemptIdentities({ refund_request_id: "ref-poc-001" })
 */
export function createAttemptIdentities(input: unknown): ValidationResult<AttemptIdentities> {
  if (!isRecord(input)) {
    return fail(["not_an_object"]);
  }
  const refundRequestId = trimmedIdentity(input.refund_request_id);
  if (refundRequestId === undefined) {
    return fail([typeof input.refund_request_id === "string" ? "empty_identity" : "invalid_identifier"]);
  }
  const attemptId = optionalUuidOrMint(input.attempt_id);
  if (!attemptId.ok) {
    return attemptId;
  }
  const providerRequestId = optionalUuidOrMint(input.provider_request_id);
  if (!providerRequestId.ok) {
    return providerRequestId;
  }
  return ok({
    refund_request_id: refundRequestId,
    attempt_id: attemptId.value,
    provider_request_id: providerRequestId.value,
  });
}
