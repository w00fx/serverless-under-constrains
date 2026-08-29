import { createHash } from "node:crypto";
import type { RejectionReason, ValidationResult } from "./types.ts";
import { isSha256Hex } from "./primitives.ts";

export function omitUndefinedAndSort(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(omitUndefinedAndSort);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) {
      continue;
    }
    Object.defineProperty(sorted, key, {
      value: omitUndefinedAndSort(item),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return sorted;
}

export function serializeCanonicalJson(value: unknown): string {
  return `${JSON.stringify(omitUndefinedAndSort(value), null, 2)}\n`;
}

export function serializeCanonicalJsonl(records: readonly unknown[]): string {
  if (records.length === 0) {
    return "";
  }
  const lines = records.map((record) => JSON.stringify(omitUndefinedAndSort(record)));
  return `${lines.join("\n")}\n`;
}

export function sha256Bytes(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyCanonicalJson(
  bytes: string,
  expectedSha256?: string,
): ValidationResult<{ value: unknown; sha256: string }> {
  const reasons: RejectionReason[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes);
  } catch (error) {
    return {
      ok: false,
      reasons: [
        {
          code: "invalid_json",
          expected: "UTF-8 JSON object or array",
          observed: error instanceof Error ? error.message : error,
        },
      ],
    };
  }

  const canonical = serializeCanonicalJson(parsed);
  if (canonical !== bytes) {
    reasons.push({
      code: "bytes_not_canonical",
      expected: "pretty-printed JSON with sorted keys and a trailing newline",
      observed: { byte_length: bytes.length, canonical_byte_length: canonical.length },
    });
  }

  const digest = sha256Bytes(bytes);
  if (expectedSha256 !== undefined) {
    if (!isSha256Hex(expectedSha256)) {
      reasons.push({
        code: "invalid_sha256",
        field: "expected_sha256",
        expected: "lowercase 64-char hex",
        observed: expectedSha256,
      });
    } else if (expectedSha256 !== digest) {
      reasons.push({
        code: "digest_mismatch",
        expected: digest,
        observed: expectedSha256,
      });
    }
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }
  return { ok: true, value: { value: parsed, sha256: digest } };
}

export function verifyCanonicalJsonl(
  bytes: string,
  expectedSha256?: string,
): ValidationResult<{ values: unknown[]; sha256: string }> {
  if (bytes === "") {
    return finishJsonl([], bytes, expectedSha256);
  }

  if (!bytes.endsWith("\n")) {
    return {
      ok: false,
      reasons: [
        {
          code: "jsonl_missing_trailing_newline",
          expected: "canonical JSONL ending with a newline",
          observed: { byte_length: bytes.length },
        },
      ],
    };
  }

  const lines = bytes.slice(0, -1).split("\n");
  const values: unknown[] = [];
  const reasons: RejectionReason[] = [];

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      reasons.push({
        code: "invalid_jsonl_line",
        field: `line[${index}]`,
        expected: "compact canonical JSON object",
        observed: error instanceof Error ? error.message : error,
      });
      continue;
    }
    const canonicalLine = JSON.stringify(omitUndefinedAndSort(parsed));
    if (canonicalLine !== line) {
      reasons.push({
        code: "jsonl_line_not_canonical",
        field: `line[${index}]`,
        expected: "compact JSON with sorted keys",
        observed: { byte_length: line.length },
      });
    }
    values.push(parsed);
  }

  if (reasons.length > 0) {
    return { ok: false, reasons };
  }

  const reconstructed = serializeCanonicalJsonl(values);
  if (reconstructed !== bytes) {
    return {
      ok: false,
      reasons: [
        {
          code: "bytes_not_canonical",
          expected: "compact JSONL with sorted keys and a trailing newline",
          observed: { byte_length: bytes.length },
        },
      ],
    };
  }

  return finishJsonl(values, bytes, expectedSha256);
}

function finishJsonl(
  values: unknown[],
  bytes: string,
  expectedSha256: string | undefined,
): ValidationResult<{ values: unknown[]; sha256: string }> {
  const digest = sha256Bytes(bytes);
  if (expectedSha256 === undefined) {
    return { ok: true, value: { values, sha256: digest } };
  }
  if (!isSha256Hex(expectedSha256)) {
    return {
      ok: false,
      reasons: [
        {
          code: "invalid_sha256",
          field: "expected_sha256",
          expected: "lowercase 64-char hex",
          observed: expectedSha256,
        },
      ],
    };
  }
  if (expectedSha256 !== digest) {
    return {
      ok: false,
      reasons: [
        {
          code: "digest_mismatch",
          expected: digest,
          observed: expectedSha256,
        },
      ],
    };
  }
  return { ok: true, value: { values, sha256: digest } };
}
