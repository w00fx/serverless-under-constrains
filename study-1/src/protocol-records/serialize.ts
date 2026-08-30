import { createHash } from "node:crypto";
import { fail, isSha256Hex, ok } from "./primitives.ts";
import type { ValidationResult } from "./types.ts";

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

function canonicalizeValue(value: unknown, seen: WeakSet<object>): ValidationResult<unknown> {
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    return fail(["unserializable_value"]);
  }
  if (value === undefined) {
    return fail(["unserializable_value"]);
  }
  if (isJsonAtomic(value)) {
    return ok(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return fail(["unserializable_value"]);
    }
    seen.add(value);
    const items: unknown[] = [];
    for (const item of value) {
      if (item === undefined) {
        return fail(["unserializable_value"]);
      }
      const canonical = canonicalizeValue(item, seen);
      if (!canonical.ok) {
        return canonical;
      }
      items.push(canonical.value);
    }
    return ok(items);
  }
  if (value === null || typeof value !== "object" || !isPlainObject(value)) {
    return fail(["unserializable_value"]);
  }
  if (seen.has(value)) {
    return fail(["unserializable_value"]);
  }
  seen.add(value);
  const source = value as Record<string, unknown>;
  const sorted = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(source).toSorted()) {
    const item = source[key];
    if (item === undefined) {
      continue;
    }
    const canonical = canonicalizeValue(item, seen);
    if (!canonical.ok) {
      return canonical;
    }
    Object.defineProperty(sorted, key, {
      configurable: true,
      enumerable: true,
      value: canonical.value,
      writable: true,
    });
  }
  return ok(sorted);
}

export function canonicalize(value: unknown): ValidationResult<unknown> {
  return canonicalizeValue(value, new WeakSet());
}

export function serializeCanonicalJson(value: unknown): ValidationResult<string> {
  const canonical = canonicalize(value);
  if (!canonical.ok) {
    return canonical;
  }
  return ok(`${JSON.stringify(canonical.value, null, 2)}\n`);
}

export function serializeCanonicalJsonl(records: readonly unknown[]): ValidationResult<string> {
  const lines: string[] = [];
  for (const record of records) {
    const canonical = canonicalize(record);
    if (!canonical.ok) {
      return canonical;
    }
    lines.push(JSON.stringify(canonical.value));
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
  const canonical = canonicalize(value);
  if (!canonical.ok) {
    return canonical;
  }
  return ok(JSON.stringify(canonical.value));
}
