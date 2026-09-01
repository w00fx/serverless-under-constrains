import { comparePaths, isPackagePath } from "./paths.ts";
import { isRecord, isSha256Hex, ownKeys } from "../protocol-records/primitives.ts";
import { encodeUtf8 } from "./utf8.ts";
import { fail, ok, type ValidationResult } from "./result.ts";
import { serializeCanonicalJson, sha256Hex } from "../protocol-records/serialize.ts";
import type {
  ArtifactClassification,
  EvidenceIndexEntry,
  EvidenceIndexRecord,
  IndexEntry,
  PackageIndexRecord,
  PackageStore,
} from "./types.ts";

const INDEX_ENTRY_KEYS = new Set(["artifact_path", "artifact_sha256", "byte_count"]);
const EVIDENCE_ENTRY_KEYS = new Set([...INDEX_ENTRY_KEYS, "classification"]);

export function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isClassification(value: unknown): value is ArtifactClassification {
  return value === "primary" || value === "derived";
}

export function entryOf(path: string, bytes: Uint8Array): IndexEntry {
  return {
    artifact_path: path,
    artifact_sha256: sha256Hex(bytes),
    byte_count: bytes.byteLength,
  };
}

export function evidenceEntryOf(
  path: string,
  bytes: Uint8Array,
  classification: ArtifactClassification,
): EvidenceIndexEntry {
  return { ...entryOf(path, bytes), classification };
}

export function sortByPath<T extends { artifact_path: string }>(entries: readonly T[]): T[] {
  return [...entries].toSorted((left, right) => comparePaths(left.artifact_path, right.artifact_path));
}

function parseIndexEntry(
  input: unknown,
  allowed: ReadonlySet<string>,
  reasons: string[],
): IndexEntry | undefined {
  if (!isRecord(input)) {
    reasons.push("not_an_object");
    return undefined;
  }
  for (const key of ownKeys(input)) {
    if (!allowed.has(key)) {
      reasons.push("unknown_property");
    }
  }
  if (!isPackagePath(input.artifact_path)) {
    reasons.push("invalid_path");
  }
  if (!isSha256Hex(input.artifact_sha256)) {
    reasons.push("invalid_sha256");
  }
  if (!isByteCount(input.byte_count)) {
    reasons.push("invalid_byte_count");
  }
  if (
    !isPackagePath(input.artifact_path) ||
    !isSha256Hex(input.artifact_sha256) ||
    !isByteCount(input.byte_count)
  ) {
    return undefined;
  }
  return {
    artifact_path: input.artifact_path,
    artifact_sha256: input.artifact_sha256,
    byte_count: input.byte_count,
  };
}

function parseEntries(
  value: unknown,
  allowed: ReadonlySet<string>,
  reasons: string[],
): IndexEntry[] | undefined {
  if (!Array.isArray(value)) {
    reasons.push("not_an_object");
    return undefined;
  }
  const entries: IndexEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = parseIndexEntry(item, allowed, reasons);
    if (entry === undefined) {
      continue;
    }
    if (seen.has(entry.artifact_path)) {
      reasons.push("duplicate_index_entry");
      continue;
    }
    seen.add(entry.artifact_path);
    entries.push(entry);
  }
  return entries;
}

export function parseEvidenceIndex(value: unknown): ValidationResult<EvidenceIndexRecord> {
  if (!isRecord(value)) {
    return fail(["not_an_object"]);
  }
  const reasons: string[] = [];
  for (const key of ownKeys(value)) {
    if (key !== "schema_version" && key !== "record_type" && key !== "entries") {
      reasons.push("unknown_property");
    }
  }
  if (value.schema_version !== 1) {
    reasons.push("invalid_schema_version");
  }
  if (value.record_type !== "evidence_index") {
    reasons.push("invalid_record_type");
  }
  if (!Array.isArray(value.entries)) {
    reasons.push("not_an_object");
    return fail(reasons);
  }
  const entries: EvidenceIndexEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.entries) {
    if (!isRecord(item)) {
      reasons.push("not_an_object");
      continue;
    }
    for (const key of ownKeys(item)) {
      if (!EVIDENCE_ENTRY_KEYS.has(key)) {
        reasons.push("unknown_property");
      }
    }
    if (!isPackagePath(item.artifact_path)) {
      reasons.push("invalid_path");
    }
    if (!isSha256Hex(item.artifact_sha256)) {
      reasons.push("invalid_sha256");
    }
    if (!isByteCount(item.byte_count)) {
      reasons.push("invalid_byte_count");
    }
    if (!isClassification(item.classification)) {
      reasons.push("invalid_classification");
    }
    if (
      !isPackagePath(item.artifact_path) ||
      !isSha256Hex(item.artifact_sha256) ||
      !isByteCount(item.byte_count) ||
      !isClassification(item.classification)
    ) {
      continue;
    }
    if (seen.has(item.artifact_path)) {
      reasons.push("duplicate_index_entry");
      continue;
    }
    seen.add(item.artifact_path);
    entries.push({
      artifact_path: item.artifact_path,
      artifact_sha256: item.artifact_sha256,
      byte_count: item.byte_count,
      classification: item.classification,
    });
  }
  return reasons.length === 0
    ? ok({
        schema_version: 1,
        record_type: "evidence_index",
        entries: sortByPath(entries),
      })
    : fail(reasons);
}

export function parsePackageIndex(value: unknown): ValidationResult<PackageIndexRecord> {
  if (!isRecord(value)) {
    return fail(["not_an_object"]);
  }
  const reasons: string[] = [];
  for (const key of ownKeys(value)) {
    if (key !== "schema_version" && key !== "record_type" && key !== "entries") {
      reasons.push("unknown_property");
    }
  }
  if (value.schema_version !== 1) {
    reasons.push("invalid_schema_version");
  }
  if (value.record_type !== "package_index") {
    reasons.push("invalid_record_type");
  }
  const entries = parseEntries(value.entries, INDEX_ENTRY_KEYS, reasons);
  return entries !== undefined && reasons.length === 0
    ? ok({
        schema_version: 1,
        record_type: "package_index",
        entries: sortByPath(entries),
      })
    : fail(reasons);
}

export function writeIndexFile(
  store: PackageStore,
  path: string,
  record: unknown,
): ValidationResult<string> {
  const serialized = serializeCanonicalJson(record);
  if (!serialized.ok) {
    return serialized;
  }
  store.set(path, encodeUtf8(serialized.value));
  return serialized;
}
