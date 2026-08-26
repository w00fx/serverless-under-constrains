import { createHash } from "node:crypto";

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
    sorted[key] = omitUndefinedAndSort(item);
  }
  return sorted;
}

export function serializeCanonicalJson(value: unknown): string {
  return `${JSON.stringify(omitUndefinedAndSort(value), null, 2)}\n`;
}

export function sha256Bytes(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
