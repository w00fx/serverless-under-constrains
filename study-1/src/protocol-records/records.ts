import {
  fail,
  isJsonPointer,
  isNormalizedRelativePosixPath,
  isPositiveSafeInteger,
  isRecord,
  isSha256Hex,
  isUuidV4,
  ok,
  ownKeys,
  trimmedIdentity,
} from "./primitives.ts";
import type {
  ApprovedDecisionRecord,
  EvidenceRef,
  PaymentRecord,
  ValidationResult,
} from "./types.ts";

const PAYMENT_KEYS = new Set([
  "schema_version",
  "record_type",
  "payment_id",
  "captured_amount_minor",
  "currency",
]);

const DECISION_KEYS = new Set([
  "schema_version",
  "record_type",
  "refund_request_id",
  "payment_id",
  "decision",
  "approved_amount_minor",
  "currency",
]);

const EVIDENCE_KEYS = new Set([
  "artifact_path",
  "artifact_sha256",
  "event_id",
  "json_pointer",
  "package_index_sha256",
]);

function pushUnknown(
  reasons: string[],
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  for (const key of ownKeys(value)) {
    if (!allowed.has(key)) {
      reasons.push(key === "evidence_references" || key === "evidence" || key === "references"
        ? "alias_rejected"
        : "unknown_property");
    }
  }
}

function pushSchema(reasons: string[], value: Record<string, unknown>, recordType: string): void {
  if (value.schema_version !== 1) {
    reasons.push("invalid_schema_version");
  }
  if (value.record_type !== recordType) {
    reasons.push("invalid_record_type");
  }
}

function pushIdentity(reasons: string[], value: unknown): string | undefined {
  const identity = trimmedIdentity(value);
  if (identity === undefined) {
    reasons.push(typeof value === "string" ? "empty_identity" : "invalid_identifier");
    return undefined;
  }
  return identity;
}

function pushAmount(reasons: string[], value: unknown): number | undefined {
  if (!isPositiveSafeInteger(value)) {
    reasons.push("invalid_amount");
    return undefined;
  }
  return value;
}

function pushCurrency(reasons: string[], value: unknown): "BRL" | undefined {
  if (value !== "BRL") {
    reasons.push("invalid_currency");
    return undefined;
  }
  return "BRL";
}

export function createPayment(input: unknown): ValidationResult<PaymentRecord> {
  if (!isRecord(input)) {
    return fail(["not_an_object"]);
  }
  const reasons: string[] = [];
  pushUnknown(reasons, input, PAYMENT_KEYS);
  pushSchema(reasons, input, "payment");
  const paymentId = pushIdentity(reasons, input.payment_id);
  const amount = pushAmount(reasons, input.captured_amount_minor);
  const currency = pushCurrency(reasons, input.currency);
  if (reasons.length > 0 || paymentId === undefined || amount === undefined || currency === undefined) {
    return fail(reasons);
  }
  return ok({
    schema_version: 1,
    record_type: "payment",
    payment_id: paymentId,
    captured_amount_minor: amount,
    currency,
  });
}

export function createApprovedDecision(input: unknown): ValidationResult<ApprovedDecisionRecord> {
  if (!isRecord(input)) {
    return fail(["not_an_object"]);
  }
  const reasons: string[] = [];
  pushUnknown(reasons, input, DECISION_KEYS);
  pushSchema(reasons, input, "approved_decision");
  const refundRequestId = pushIdentity(reasons, input.refund_request_id);
  const paymentId = pushIdentity(reasons, input.payment_id);
  if (input.decision !== "APPROVED") {
    reasons.push("invalid_decision");
  }
  const amount = pushAmount(reasons, input.approved_amount_minor);
  const currency = pushCurrency(reasons, input.currency);
  if (
    reasons.length > 0 ||
    refundRequestId === undefined ||
    paymentId === undefined ||
    amount === undefined ||
    currency === undefined
  ) {
    return fail(reasons);
  }
  return ok({
    schema_version: 1,
    record_type: "approved_decision",
    refund_request_id: refundRequestId,
    payment_id: paymentId,
    decision: "APPROVED",
    approved_amount_minor: amount,
    currency,
  });
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  const leftRank = left === undefined ? 0 : 1;
  const rightRank = right === undefined ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (left === undefined || right === undefined) {
    return 0;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEvidence(left: EvidenceRef, right: EvidenceRef): number {
  if (left.artifact_path !== right.artifact_path) {
    return Number(left.artifact_path > right.artifact_path) - Number(left.artifact_path < right.artifact_path);
  }
  return (
    compareOptional(left.event_id, right.event_id) ||
    compareOptional(left.json_pointer, right.json_pointer) ||
    compareOptional(left.package_index_sha256, right.package_index_sha256)
  );
}

function createEvidenceRef(input: unknown): ValidationResult<EvidenceRef> {
  if (!isRecord(input)) {
    return fail(["not_an_object"]);
  }
  const reasons: string[] = [];
  pushUnknown(reasons, input, EVIDENCE_KEYS);
  if (!isNormalizedRelativePosixPath(input.artifact_path)) {
    reasons.push("invalid_path");
  }
  if (!isSha256Hex(input.artifact_sha256)) {
    reasons.push("invalid_sha256");
  }
  if (input.event_id !== undefined && !isUuidV4(input.event_id)) {
    reasons.push("invalid_uuid");
  }
  if (input.json_pointer !== undefined && !isJsonPointer(input.json_pointer)) {
    reasons.push("invalid_json_pointer");
  }
  if (input.package_index_sha256 !== undefined && !isSha256Hex(input.package_index_sha256)) {
    reasons.push("invalid_sha256");
  }
  if (reasons.length > 0 || !isNormalizedRelativePosixPath(input.artifact_path) || !isSha256Hex(input.artifact_sha256)) {
    return fail(reasons);
  }
  const ref: EvidenceRef = {
    artifact_path: input.artifact_path,
    artifact_sha256: input.artifact_sha256,
  };
  if (typeof input.event_id === "string") {
    ref.event_id = input.event_id;
  }
  if (typeof input.json_pointer === "string") {
    ref.json_pointer = input.json_pointer;
  }
  if (typeof input.package_index_sha256 === "string") {
    ref.package_index_sha256 = input.package_index_sha256;
  }
  return ok(ref);
}

export function createEvidenceRefs(input: unknown): ValidationResult<EvidenceRef[]> {
  if (!Array.isArray(input)) {
    return fail(["not_an_object"]);
  }
  const refs: EvidenceRef[] = [];
  const reasons: string[] = [];
  for (const item of input) {
    const created = createEvidenceRef(item);
    if (!created.ok) {
      reasons.push(...created.reasons);
      continue;
    }
    refs.push(created.value);
  }
  if (reasons.length > 0) {
    return fail(reasons);
  }
  const sorted = [...refs].toSorted(compareEvidence);
  const seen = new Set<string>();
  for (const ref of sorted) {
    const key = `${ref.artifact_path}\n${ref.json_pointer ?? ""}`;
    if (seen.has(key)) {
      return fail(["duplicate_evidence_ref"]);
    }
    seen.add(key);
  }
  return ok(sorted);
}
