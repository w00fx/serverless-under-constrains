import { readCheckpoint, validateCheckpointAgainstJournal } from "./checkpoint.ts";
import { isRecord } from "../protocol-records/primitives.ts";
import { evidenceEntryOf, isClassification, sortByPath, writeIndexFile } from "./entries.ts";
import { fail, ok, type ValidationResult } from "./result.ts";
import {
  CHECKPOINT_PATH,
  EVIDENCE_INDEX_PATH,
  JOURNAL_PATH,
  PACKAGE_INDEX_PATH,
  isLateEvidencePath,
  isPackagePath,
} from "./paths.ts";
import { isPackageStore, storeBytes } from "./store.ts";
import type { ArtifactClassification, EvidenceIndexEntry, EvidenceIndexRecord, PackageStore } from "./types.ts";

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

function indexedPaths(
  store: PackageStore,
  hasCheckpoint: boolean,
): string[] {
  const paths: string[] = [];
  for (const path of store.keys()) {
    if (!isPackagePath(path)) {
      continue;
    }
    if (isLateEvidencePath(path) || path === EVIDENCE_INDEX_PATH || path === PACKAGE_INDEX_PATH) {
      continue;
    }
    if (hasCheckpoint && path === JOURNAL_PATH) {
      continue;
    }
    paths.push(path);
  }
  return paths;
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
  const checkpointBytes = storeBytes(store, CHECKPOINT_PATH);
  const journalBytes = storeBytes(store, JOURNAL_PATH);
  const hasCheckpoint = checkpointBytes !== undefined;
  if (hasCheckpoint) {
    if (journalBytes === undefined) {
      reasons.push("missing_file");
    } else {
      const checkpoint = readCheckpoint(checkpointBytes);
      if (!checkpoint.ok) {
        reasons.push("malformed_checkpoint");
      } else {
        const aligned = validateCheckpointAgainstJournal(checkpoint.value, journalBytes);
        if (!aligned.ok) {
          reasons.push(...aligned.reasons);
        }
      }
    }
  }
  const entries: EvidenceIndexEntry[] = [];
  const indexed = indexedPaths(store, hasCheckpoint);
  for (const path of indexed) {
    const bytes = storeBytes(store, path);
    const classification = classificationOf(classifications, path, reasons);
    if (bytes === undefined || classification === undefined) {
      continue;
    }
    entries.push(evidenceEntryOf(path, bytes, classification));
  }
  for (const path of Object.keys(classifications)) {
    if (
      isLateEvidencePath(path) ||
      path === EVIDENCE_INDEX_PATH ||
      path === PACKAGE_INDEX_PATH ||
      (hasCheckpoint && path === JOURNAL_PATH)
    ) {
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
