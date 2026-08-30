import type { ValidationFailure, ValidationResult } from "./types.ts";

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
export const RECORD_TYPE = /^[a-z][a-z0-9_]*$/;
export const REJECTED_ALIASES = ["evidence_references", "evidence", "references"];

export function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

export function fail(reasons: readonly string[]): ValidationFailure {
  return { ok: false, reasons: [...new Set(reasons)] };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

export function isUtcMillisecondTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = TIMESTAMP.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second &&
    date.getUTCMilliseconds() === millisecond
  );
}

export function trimmedIdentity(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function isNormalizedRelativePosixPath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.startsWith("/") || value.includes("\\")) {
    return false;
  }
  if (value.endsWith("/") || value.includes(":")) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isJsonPointer(value: unknown): value is string {
  return typeof value === "string" && (value === "" || value.startsWith("/"));
}

export function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}
