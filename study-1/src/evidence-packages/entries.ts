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
  return Number.isSafeInteger(value) && Number(value) >= 0;
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
    return undefined;
  }
  if (!isSha256Hex(input.artifact_sha256)) {
    reasons.push("invalid_sha256");
    return undefined;
  }
  if (!isByteCount(input.byte_count)) {
    reasons.push("invalid_byte_count");
    return undefined;
  }
  return {
    artifact_path: input.artifact_path,
    artifact_sha256: input.artifact_sha256,
    byte_count: input.byte_count,
  };
}

function collectIndexEntries<T extends IndexEntry>(
  items: readonly unknown[],
  allowed: ReadonlySet<string>,
  reasons: string[],
  classify: (item: Record<string, unknown>, entry: IndexEntry, reasons: string[]) => T | undefined,
): T[] {
  const entries: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const entry = parseIndexEntry(item, allowed, reasons);
    if (entry === undefined) {
      continue;
    }
    const classified = classify(item as Record<string, unknown>, entry, reasons);
    if (classified === undefined) {
      continue;
    }
    if (seen.has(classified.artifact_path)) {
      reasons.push("duplicate_index_entry");
      continue;
    }
    seen.add(classified.artifact_path);
    entries.push(classified);
  }
  return entries;
}

function readIndexEnvelope(
  value: unknown,
  recordType: string,
): { reasons: string[]; items: unknown[] | undefined } {
  if (!isRecord(value)) {
    return { reasons: ["not_an_object"], items: undefined };
  }
  const reasons: string[] = [];
  for (const key of ownKeys(value)) {
    if (key !== "schema_version" && key !== "record_type" && key !== "entries") {
      reasons.push("unknown_property");
    }
  }
  const versionOk = value.schema_version === 1;
  if (!versionOk) {
    reasons.push("invalid_schema_version");
  }
  const typeOk = value.record_type === recordType;
  if (!typeOk) {
    reasons.push("invalid_record_type");
  }
  if (!Array.isArray(value.entries)) {
    reasons.push("not_an_object");
    return { reasons, items: undefined };
  }
  return { reasons, items: value.entries };
}

export function parseEvidenceIndex(value: unknown): ValidationResult<EvidenceIndexRecord> {
  const envelope = readIndexEnvelope(value, "evidence_index");
  if (envelope.items === undefined) {
    return fail(envelope.reasons);
  }
  const entries = collectIndexEntries(
    envelope.items,
    EVIDENCE_ENTRY_KEYS,
    envelope.reasons,
    (item, entry, reasons) => {
      if (!isClassification(item.classification)) {
        reasons.push("invalid_classification");
        return undefined;
      }
      return { ...entry, classification: item.classification };
    },
  );
  return envelope.reasons.length === 0
    ? ok({
        schema_version: 1,
        record_type: "evidence_index",
        entries: sortByPath(entries),
      })
    : fail(envelope.reasons);
}

export function parsePackageIndex(value: unknown): ValidationResult<PackageIndexRecord> {
  const envelope = readIndexEnvelope(value, "package_index");
  if (envelope.items === undefined) {
    return fail(envelope.reasons);
  }
  const entries = collectIndexEntries(
    envelope.items,
    INDEX_ENTRY_KEYS,
    envelope.reasons,
    (_item, entry) => entry,
  );
  return envelope.reasons.length === 0
    ? ok({
        schema_version: 1,
        record_type: "package_index",
        entries: sortByPath(entries),
      })
    : fail(envelope.reasons);
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
