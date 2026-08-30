import { createHash } from "node:crypto";
import { fail, isSha256Hex, ok } from "./primitives.ts";
import type { ValidationResult } from "./types.ts";

const INDENT = "  ";

function isJsonAtomic(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function block(
  open: string,
  parts: readonly string[],
  close: string,
  depth: number,
  pretty: boolean,
): string {
  if (parts.length === 0) {
    return `${open}${close}`;
  }
  if (!pretty) {
    return `${open}${parts.join(",")}${close}`;
  }
  const inner = INDENT.repeat(depth + 1);
  return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${INDENT.repeat(depth)}${close}`;
}

function writeArray(
  value: readonly unknown[],
  depth: number,
  pretty: boolean,
  ancestors: Set<object>,
): ValidationResult<string> {
  const parts: string[] = [];
  for (const item of value) {
    const written = writeJson(item, depth + 1, pretty, ancestors);
    if (!written.ok) {
      return written;
    }
    parts.push(written.value);
  }
  return ok(block("[", parts, "]", depth, pretty));
}

function writeObject(
  value: Record<string, unknown>,
  depth: number,
  pretty: boolean,
  ancestors: Set<object>,
): ValidationResult<string> {
  const parts: string[] = [];
  for (const key of Object.keys(value).toSorted()) {
    const item = value[key];
    if (item === undefined) {
      continue;
    }
    const written = writeJson(item, depth + 1, pretty, ancestors);
    if (!written.ok) {
      return written;
    }
    parts.push(`${JSON.stringify(key)}:${pretty ? " " : ""}${written.value}`);
  }
  return ok(block("{", parts, "}", depth, pretty));
}

// Keys are emitted in UTF-16 code-unit order. JSON.stringify cannot be used for
// objects because property enumeration always lists integer-like keys first in
// ascending numeric order, which contradicts the serialization contract.
function writeJson(
  value: unknown,
  depth: number,
  pretty: boolean,
  ancestors: Set<object>,
): ValidationResult<string> {
  if (typeof value === "object" && value !== null) {
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return fail(["unserializable_value"]);
    }
    if (ancestors.has(value)) {
      return fail(["unserializable_value"]);
    }
    ancestors.add(value);
    const written = Array.isArray(value)
      ? writeArray(value, depth, pretty, ancestors)
      : writeObject(value as Record<string, unknown>, depth, pretty, ancestors);
    ancestors.delete(value);
    return written;
  }
  if (isJsonAtomic(value)) {
    return ok(JSON.stringify(value));
  }
  return fail(["unserializable_value"]);
}

export function serializeCanonicalJson(value: unknown): ValidationResult<string> {
  const written = writeJson(value, 0, true, new Set());
  if (!written.ok) {
    return written;
  }
  return ok(`${written.value}\n`);
}

export function serializeCanonicalJsonl(records: readonly unknown[]): ValidationResult<string> {
  const lines: string[] = [];
  for (const record of records) {
    const written = writeJson(record, 0, false, new Set());
    if (!written.ok) {
      return written;
    }
    lines.push(written.value);
  }
  return ok(`${lines.join("\n")}\n`);
}

export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyCanonicalBytes(
  value: unknown,
  expectedBytes: string,
): ValidationResult<string> {
  const serialized = serializeCanonicalJson(value);
  if (!serialized.ok) {
    return serialized;
  }
  if (serialized.value !== expectedBytes) {
    return fail(["canonical_bytes_mismatch"]);
  }
  return serialized;
}

export function verifyDigest(bytes: string, expectedDigest: string): ValidationResult<string> {
  if (!isSha256Hex(expectedDigest)) {
    return fail(["invalid_sha256"]);
  }
  const digest = sha256Hex(bytes);
  if (digest !== expectedDigest) {
    return fail(["digest_mismatch"]);
  }
  return ok(digest);
}

export function structuralKey(value: unknown): ValidationResult<string> {
  return writeJson(value, 0, false, new Set());
}
