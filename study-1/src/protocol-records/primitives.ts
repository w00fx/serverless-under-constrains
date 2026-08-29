import { MAX_SAFE_AMOUNT_MINOR, SHA256_HEX_PATTERN } from "./types.ts";

const LOWERCASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_UTC_MILLISECOND =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CANONICAL_RECORD_TYPE = /^[a-z][a-z0-9_]*$/;
const CANONICAL_MONOTONIC_NANOS = /^(0|[1-9][0-9]*)$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isLowercaseUuidV4(value: unknown): value is string {
  return typeof value === "string" && LOWERCASE_UUID_V4.test(value);
}

export function isNonemptyTrimmedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function trimmedIdentifier(value: unknown): string | undefined {
  if (!isNonemptyTrimmedIdentifier(value)) {
    return undefined;
  }
  return value.trim();
}

export function isCanonicalUtcMillisecondTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !CANONICAL_UTC_MILLISECOND.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.toISOString() === value;
}

export function isCanonicalRecordType(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_RECORD_TYPE.test(value);
}

export function isPositiveSafeAmountMinor(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_SAFE_AMOUNT_MINOR
  );
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

export function isNormalizedRelativePosixPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "") {
    return false;
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isPositiveSafeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isCanonicalMonotonicNanos(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_MONOTONIC_NANOS.test(value);
}

export function isCanonicalJsonPointer(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/");
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
