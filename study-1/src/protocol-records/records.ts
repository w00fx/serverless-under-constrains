import {
  compareCodeUnits,
  isCanonicalJsonPointer,
  isLowercaseUuidV4,
  isNormalizedRelativePosixPath,
  isPlainObject,
  isPositiveSafeAmountMinor,
  isSha256Hex,
  trimmedIdentifier,
} from "./primitives.ts";
import {
  ALLOWED_CURRENCY,
  EVIDENCE_REF_ALIASES,
  EVIDENCE_REF_KEYS,
  MAX_SAFE_AMOUNT_MINOR,
  SCHEMA_VERSION,
  type ApprovedDecision,
  type CreateEvidenceRefsOptions,
  type EvidenceRef,
  type Payment,
  type RejectionReason,
  type ValidationResult,
} from "./types.ts";

const ALIAS_SET: ReadonlySet<string> = new Set(EVIDENCE_REF_ALIASES);

const PAYMENT_KEYS = [
  "schema_version",
  "record_type",
  "payment_id",
  "captured_amount_minor",
  "currency",
] as const;

const APPROVED_DECISION_KEYS = [
  "schema_version",
  "record_type",
  "refund_request_id",
  "payment_id",
  "decision",
  "approved_amount_minor",
  "currency",
] as const;

export function createPayment(input: unknown): ValidationResult<Payment> {
  const objectResult = requirePlainObject(input);
  if (!objectResult.ok) {
    return objectResult;
  }
  const raw = objectResult.value;
  const reasons = unknownPropertyReasons(raw, PAYMENT_KEYS);
  pushSchemaVersion(reasons, raw.schema_version);
  pushExactRecordType(reasons, raw.record_type, "payment");
  const paymentId = pushIdentifier(reasons, "payment_id", raw.payment_id);
  pushAmount(reasons, "captured_amount_minor", raw.captured_amount_minor);
  pushCurrency(reasons, raw.currency);
  if (
    reasons.length > 0 ||
    paymentId === undefined ||
    !isPositiveSafeAmountMinor(raw.captured_amount_minor)
  ) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    value: {
      schema_version: SCHEMA_VERSION,
      record_type: "payment",
      payment_id: paymentId,
      captured_amount_minor: raw.captured_amount_minor,
      currency: ALLOWED_CURRENCY,
    },
  };
}

export function createApprovedDecision(input: unknown): ValidationResult<ApprovedDecision> {
  const objectResult = requirePlainObject(input);
  if (!objectResult.ok) {
    return objectResult;
  }
  const raw = objectResult.value;
  const reasons = unknownPropertyReasons(raw, APPROVED_DECISION_KEYS);
  pushSchemaVersion(reasons, raw.schema_version);
  pushExactRecordType(reasons, raw.record_type, "approved_decision");
  const refundRequestId = pushIdentifier(reasons, "refund_request_id", raw.refund_request_id);
  const paymentId = pushIdentifier(reasons, "payment_id", raw.payment_id);
  if (raw.decision !== "APPROVED") {
    reasons.push({
      code: "decision_not_approved",
      field: "decision",
      expected: "APPROVED",
      observed: raw.decision,
    });
  }
  pushAmount(reasons, "approved_amount_minor", raw.approved_amount_minor);
  pushCurrency(reasons, raw.currency);
  if (
    reasons.length > 0 ||
    refundRequestId === undefined ||
    paymentId === undefined ||
    !isPositiveSafeAmountMinor(raw.approved_amount_minor)
  ) {
    return { ok: false, reasons };
  }
  return {
    ok: true,
    value: {
      schema_version: SCHEMA_VERSION,
      record_type: "approved_decision",
      refund_request_id: refundRequestId,
      payment_id: paymentId,
      decision: "APPROVED",
      approved_amount_minor: raw.approved_amount_minor,
      currency: ALLOWED_CURRENCY,
    },
  };
}

export function requirePlainObject(input: unknown): ValidationResult<Record<string, unknown>> {
  if (!isPlainObject(input)) {
    return {
      ok: false,
      reasons: [
        {
          code: "not_an_object",
          expected: "plain object",
          observed: input === null ? null : Array.isArray(input) ? "array" : typeof input,
        },
      ],
    };
  }
  return { ok: true, value: input };
}

export function unknownPropertyReasons(
  input: Record<string, unknown>,
  allowed: readonly string[],
  fieldPrefix?: string,
): RejectionReason[] {
  const allowedSet = new Set(allowed);
  const reasons: RejectionReason[] = [];
  for (const key of Object.keys(input)) {
    if (!allowedSet.has(key)) {
      reasons.push({
        code: "unknown_property",
        field: fieldPrefix === undefined ? key : `${fieldPrefix}.${key}`,
        expected: [...allowed],
        observed: key,
      });
    }
  }
  return reasons;
}

export function pushSchemaVersion(reasons: RejectionReason[], value: unknown): void {
  if (value !== SCHEMA_VERSION) {
    reasons.push({
      code: "invalid_schema_version",
      field: "schema_version",
      expected: SCHEMA_VERSION,
      observed: value,
    });
  }
}

export function pushIdentifier(
  reasons: RejectionReason[],
  field: string,
  value: unknown,
): string | undefined {
  const trimmed = trimmedIdentifier(value);
  if (trimmed === undefined) {
    reasons.push({
      code: "identifier_empty",
      field,
      expected: "nonempty identifier after trim",
      observed: value,
    });
  }
  return trimmed;
}

function pushExactRecordType(
  reasons: RejectionReason[],
  value: unknown,
  expected: "payment" | "approved_decision",
): void {
  if (value !== expected) {
    reasons.push({
      code: "invalid_record_type",
      field: "record_type",
      expected,
      observed: value,
    });
  }
}

function pushAmount(reasons: RejectionReason[], field: string, value: unknown): void {
  if (!isPositiveSafeAmountMinor(value)) {
    reasons.push({
      code: "invalid_amount_minor",
      field,
      expected: { min: 1, max: MAX_SAFE_AMOUNT_MINOR, integer: true },
      observed: value,
    });
  }
}

function pushCurrency(reasons: RejectionReason[], value: unknown): void {
  if (value !== ALLOWED_CURRENCY) {
    reasons.push({
      code: "invalid_currency",
      field: "currency",
      expected: ALLOWED_CURRENCY,
      observed: value,
    });
  }
}

export function createEvidenceRefs(
  input: unknown,
  options: CreateEvidenceRefsOptions = {},
): ValidationResult<EvidenceRef[]> {
  if (isPlainObject(input)) {
    const reasons: RejectionReason[] = [];
    for (const alias of EVIDENCE_REF_ALIASES) {
      if (Object.hasOwn(input, alias)) {
        reasons.push({
          code: "rejected_alias",
          field: alias,
          expected: "evidence_refs",
          observed: alias,
        });
      }
    }
    for (const key of Object.keys(input)) {
      if (key !== "evidence_refs" && !ALIAS_SET.has(key)) {
        reasons.push({
          code: "unknown_property",
          field: key,
          expected: ["evidence_refs"],
          observed: key,
        });
      }
    }
    if (reasons.length > 0) {
      return { ok: false, reasons };
    }
    return createEvidenceRefArray(input.evidence_refs, options);
  }
  return createEvidenceRefArray(input, options);
}

function createEvidenceRefArray(
  input: unknown,
  options: CreateEvidenceRefsOptions,
): ValidationResult<EvidenceRef[]> {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      reasons: [
        {
          code: "not_an_array",
          field: "evidence_refs",
          expected: "array",
          observed: input === null ? null : typeof input,
        },
      ],
    };
  }

  const reasons: RejectionReason[] = [];
  const refs: EvidenceRef[] = [];
  const seen = new Set<string>();

  for (const [index, item] of input.entries()) {
    const prefix = `evidence_refs[${index}]`;
    if (!isPlainObject(item)) {
      reasons.push({
        code: "not_an_object",
        field: prefix,
        expected: "plain object",
        observed: item === null ? null : Array.isArray(item) ? "array" : typeof item,
      });
      continue;
    }
    reasons.push(...unknownPropertyReasons(item, EVIDENCE_REF_KEYS, prefix));
    if (!isNormalizedRelativePosixPath(item.artifact_path)) {
      reasons.push({
        code: "invalid_path",
        field: `${prefix}.artifact_path`,
        expected: "normalized package-relative POSIX path",
        observed: item.artifact_path,
      });
    }
    if (!isSha256Hex(item.artifact_sha256)) {
      reasons.push({
        code: "invalid_sha256",
        field: `${prefix}.artifact_sha256`,
        expected: "lowercase 64-char hex",
        observed: item.artifact_sha256,
      });
    }
    if (item.event_id !== undefined && !isLowercaseUuidV4(item.event_id)) {
      reasons.push({
        code: "invalid_uuid",
        field: `${prefix}.event_id`,
        expected: "lowercase UUIDv4",
        observed: item.event_id,
      });
    }
    if (item.json_pointer !== undefined && !isCanonicalJsonPointer(item.json_pointer)) {
      reasons.push({
        code: "invalid_json_pointer",
        field: `${prefix}.json_pointer`,
        expected: "nonempty string starting with /",
        observed: item.json_pointer,
      });
    }
    if (item.package_index_sha256 !== undefined && !isSha256Hex(item.package_index_sha256)) {
      reasons.push({
        code: "invalid_sha256",
        field: `${prefix}.package_index_sha256`,
        expected: "lowercase 64-char hex",
        observed: item.package_index_sha256,
      });
    }
    if (options.requirePackageIndex && item.package_index_sha256 === undefined) {
      reasons.push({
        code: "missing_package_index_sha256",
        field: `${prefix}.package_index_sha256`,
        expected: "lowercase 64-char hex",
        observed: undefined,
      });
    }
    if (!isNormalizedRelativePosixPath(item.artifact_path)) {
      continue;
    }
    const pointer = typeof item.json_pointer === "string" ? item.json_pointer : "";
    const duplicateKey = `${item.artifact_path}\0${pointer}`;
    if (seen.has(duplicateKey)) {
      reasons.push({
        code: "duplicate_evidence_ref",
        field: prefix,
        expected: "unique artifact_path and json_pointer",
        observed: { artifact_path: item.artifact_path, json_pointer: item.json_pointer },
      });
    }
    seen.add(duplicateKey);
    if (!isSha256Hex(item.artifact_sha256)) {
      continue;
    }
    const ref: EvidenceRef = {
      artifact_path: item.artifact_path,
      artifact_sha256: item.artifact_sha256,
    };
    if (typeof item.event_id === "string") {
      ref.event_id = item.event_id;
    }
    if (typeof item.json_pointer === "string") {
      ref.json_pointer = item.json_pointer;
    }
    if (typeof item.package_index_sha256 === "string") {
      ref.package_index_sha256 = item.package_index_sha256;
    }
    refs.push(ref);
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, value: refs.toSorted(compareEvidenceRefs) };
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === right) {
    return 0;
  }
  if (left === undefined) {
    return -1;
  }
  if (right === undefined) {
    return 1;
  }
  return compareCodeUnits(left, right);
}

function compareEvidenceRefs(left: EvidenceRef, right: EvidenceRef): number {
  return (
    compareCodeUnits(left.artifact_path, right.artifact_path) ||
    compareOptional(left.event_id, right.event_id) ||
    compareOptional(left.json_pointer, right.json_pointer) ||
    compareOptional(left.package_index_sha256, right.package_index_sha256)
  );
}
