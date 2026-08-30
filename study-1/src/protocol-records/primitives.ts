import type { ValidationFailure, ValidationResult } from "./types.ts";

export const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
export const RECORD_TYPE = /^[a-z][a-z0-9_]*$/;
export const REJECTED_ALIASES = ["evidence_references", "evidence", "references"];

const DAYS_IN_MONTH = [0, 31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

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
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    if (year % 400 === 0) {
      return 29;
    }
    if (year % 100 === 0) {
      return 28;
    }
    return year % 4 === 0 ? 29 : 28;
  }
  return DAYS_IN_MONTH[month] ?? 0;
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
  // Date.UTC maps years 0-99 to 1900-1999, so those four-digit years are not
  // round-trippable as written. Keep that rejection while checking the calendar
  // fields directly so each bound is independently observable.
  return (
    year >= 100 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
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
  if (typeof value !== "string" || value.includes("\\") || value.includes(":")) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isJsonPointer(value: unknown): value is string {
  return typeof value === "string" && (value === "" || value.startsWith("/"));
}

export function ownKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value);
}
