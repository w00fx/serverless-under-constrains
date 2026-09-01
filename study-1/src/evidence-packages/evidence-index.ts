import { checkpointAlignmentReasons } from "./checkpoint.ts";
import { isRecord } from "../protocol-records/primitives.ts";
import { evidenceEntryOf, isClassification, sortByPath, writeIndexFile } from "./entries.ts";
import { fail, ok, type ValidationResult } from "./result.ts";
import {
  CHECKPOINT_PATH,
  EVIDENCE_INDEX_PATH,
  JOURNAL_PATH,
  PACKAGE_INDEX_PATH,
  isExcludedFromEvidenceIndex,
  isEvidenceIndexedPath,
  isPackagePath,
} from "./paths.ts";
import { isPackageStore, storeBytes } from "./store.ts";
import type { ArtifactClassification, EvidenceIndexEntry, EvidenceIndexRecord } from "./types.ts";

function classificationOf(
  classifications: Record<string, unknown>,
  path: string,
  reasons: string[],
): ArtifactClassification | undefined {
  const value = classifications[path];
  if (value === undefined) {
    reasons.push("invalid_classification");
    return undefined;
  }
  if (!isClassification(value)) {
    reasons.push("invalid_classification");
    return undefined;
  }
  if ((path === CHECKPOINT_PATH || path === JOURNAL_PATH) && value !== "primary") {
    reasons.push("invalid_classification");
    return undefined;
  }
  return value;
}

export function writeEvidenceIndex(
  store: unknown,
  classifications: unknown,
): ValidationResult<EvidenceIndexRecord> {
  if (!isPackageStore(store) || !isRecord(classifications)) {
    return fail(["not_an_object"]);
  }
  if (store.has(EVIDENCE_INDEX_PATH) || store.has(PACKAGE_INDEX_PATH)) {
    return fail(["rewrite_forbidden"]);
  }
  const reasons: string[] = [];
  for (const path of store.keys()) {
    if (!isPackagePath(path) || !(store.get(path) instanceof Uint8Array)) {
      reasons.push("invalid_path");
    }
  }
  const checkpoint = checkpointAlignmentReasons(store);
  reasons.push(...checkpoint.reasons);
  const entries: EvidenceIndexEntry[] = [];
  for (const path of store.keys()) {
    if (!isEvidenceIndexedPath(path, checkpoint.hasCheckpoint)) {
      continue;
    }
    const bytes = storeBytes(store, path);
    const classification = classificationOf(classifications, path, reasons);
    if (bytes === undefined || classification === undefined) {
      continue;
    }
    entries.push(evidenceEntryOf(path, bytes, classification));
  }
  for (const path of Object.keys(classifications)) {
    if (isExcludedFromEvidenceIndex(path, checkpoint.hasCheckpoint)) {
      reasons.push("invalid_classification");
      continue;
    }
    if (storeBytes(store, path) === undefined) {
      reasons.push("missing_file");
    }
  }
  if (reasons.length > 0) {
    return fail(reasons);
  }
  const record: EvidenceIndexRecord = {
    schema_version: 1,
    record_type: "evidence_index",
    entries: sortByPath(entries),
  };
  writeIndexFile(store, EVIDENCE_INDEX_PATH, record);
  return ok(record);
}
