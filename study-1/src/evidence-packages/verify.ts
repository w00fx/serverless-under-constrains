import { checkpointAlignmentReasons } from "./checkpoint.ts";
import { isRecord, isUtcMillisecondTimestamp } from "../protocol-records/primitives.ts";
import { sha256Hex } from "../protocol-records/serialize.ts";
import * as outcome from "./result.ts";
import type { ValidationResult } from "./result.ts";
import * as reserved from "./paths.ts";
import { parseEvidenceIndex, parsePackageIndex } from "./entries.ts";
import { collectReferenceReasons } from "./references.ts";
import { isPackageStore, storeBytes } from "./store.ts";
import type {
  EvidenceIndexRecord,
  PackageIndexRecord,
  PackageStore,
  PackageVerification,
} from "./types.ts";
import { decodeUtf8 } from "./utf8.ts";

const EMPTY_DIGEST = sha256Hex(new Uint8Array());

function parseJson(bytes: Uint8Array | undefined): unknown {
  try {
    return JSON.parse(String(decodeUtf8(bytes ?? new Uint8Array())));
  } catch {
    return undefined;
  }
}

function packageIndexReasons(store: PackageStore, record: PackageIndexRecord | undefined): string[] {
  const reasons: string[] = [];
  const listed = new Set<string>();
  if (record === undefined) {
    if (storeBytes(store, reserved.PACKAGE_INDEX_PATH) === undefined) {
      reasons.push("missing_file");
    }
    return reasons;
  }
  for (const entry of record.entries) {
    if (entry.artifact_path === reserved.PACKAGE_INDEX_PATH) {
      reasons.push("self_indexed_package_index");
    }
    listed.add(entry.artifact_path);
    const bytes = storeBytes(store, entry.artifact_path);
    if (bytes === undefined) {
      reasons.push("missing_file");
      continue;
    }
    if (sha256Hex(bytes) !== entry.artifact_sha256) {
      reasons.push("digest_mismatch");
    }
    if (bytes.byteLength !== entry.byte_count) {
      reasons.push("byte_count_mismatch");
    }
  }
  for (const name of [...store.keys()]) {
    if (reserved.isPackagePath(name) === false) {
      continue;
    }
    if (name !== reserved.PACKAGE_INDEX_PATH && !listed.has(name)) {
      reasons.push("package_index_incomplete");
    }
  }
  return reasons;
}

function expectedEvidencePaths(store: PackageStore, hasCheckpoint: boolean): Set<string> {
  const expected = new Set<string>();
  for (const name of store.keys()) {
    if (reserved.isEvidenceIndexedPath(name, hasCheckpoint)) {
      expected.add(name);
    }
  }
  return expected;
}

function evidenceIndexReasons(
  store: PackageStore,
  record: EvidenceIndexRecord | undefined,
  hasCheckpoint: boolean,
): string[] {
  const reasons: string[] = [];
  if (record === undefined) {
    if (storeBytes(store, reserved.EVIDENCE_INDEX_PATH) === undefined) {
      reasons.push("missing_evidence_index");
    }
    return reasons;
  }
  const listed = new Set<string>();
  for (const entry of record.entries) {
    if (entry.artifact_path === reserved.EVIDENCE_INDEX_PATH) {
      reasons.push("self_indexed_evidence_index");
    }
    if (reserved.isLateEvidencePath(entry.artifact_path)) {
      reasons.push("late_evidence_in_evidence_index");
    }
    if (hasCheckpoint && entry.artifact_path === reserved.JOURNAL_PATH) {
      reasons.push("evidence_index_incomplete");
    }
    listed.add(entry.artifact_path);
    const bytes = storeBytes(store, entry.artifact_path);
    if (bytes === undefined) {
      reasons.push("missing_file");
      continue;
    }
    if (sha256Hex(bytes) !== entry.artifact_sha256) {
      reasons.push("digest_mismatch");
    }
    if (bytes.byteLength !== entry.byte_count) {
      reasons.push("byte_count_mismatch");
    }
    if ((entry.artifact_path === reserved.CHECKPOINT_PATH || entry.artifact_path === reserved.JOURNAL_PATH) && entry.classification !== "primary") {
      reasons.push("invalid_classification");
    }
  }
  for (const path of expectedEvidencePaths(store, hasCheckpoint)) {
    if (!listed.has(path)) {
      reasons.push("evidence_index_incomplete");
    }
  }
  return reasons;
}

export function verifyOriginalPackage(
  store: unknown,
  request: unknown,
): ValidationResult<PackageVerification> {
  if (!isPackageStore(store) || !isRecord(request) || typeof request.now !== "function") {
    return outcome.fail(["not_an_object"]);
  }
  const evaluatedAt = request.now();
  if (!isUtcMillisecondTimestamp(evaluatedAt)) {
    return outcome.fail(["invalid_timestamp"]);
  }
  const reasons: string[] = [];
  if (request.selected_amendment_head_sha256 !== null) {
    reasons.push("selected_amendment_unsupported");
  }
  for (const name of [...store.keys()]) {
    if (reserved.isPackagePath(name) === false || store.get(name) instanceof Uint8Array === false) {
      reasons.push("invalid_path");
    }
  }
  const packageBytes = storeBytes(store, reserved.PACKAGE_INDEX_PATH);
  const originalDigest = packageBytes === undefined ? EMPTY_DIGEST : sha256Hex(packageBytes);
  const parsedPackage = parsePackageIndex(parseJson(packageBytes));
  const packageRecord = parsedPackage.ok ? parsedPackage.value : undefined;
  if (!parsedPackage.ok && packageBytes !== undefined) {
    reasons.push(...parsedPackage.reasons);
  }
  reasons.push(...packageIndexReasons(store, packageRecord));
  const checkpoint = checkpointAlignmentReasons(store);
  reasons.push(...checkpoint.reasons);
  const evidenceBytes = storeBytes(store, reserved.EVIDENCE_INDEX_PATH);
  const parsedEvidence = parseEvidenceIndex(parseJson(evidenceBytes));
  const evidenceRecord = parsedEvidence.ok ? parsedEvidence.value : undefined;
  if (!parsedEvidence.ok && evidenceBytes !== undefined) {
    reasons.push(...parsedEvidence.reasons);
  }
  reasons.push(...evidenceIndexReasons(store, evidenceRecord, checkpoint.hasCheckpoint));
  reasons.push(...collectReferenceReasons(store, originalDigest));
  const unique = [...new Set(reasons)].toSorted();
  return outcome.ok({
    schema_version: 1,
    record_type: "package_verification",
    package_eligibility: unique.length === 0 ? "eligible" : "ineligible",
    package_ineligibility_reasons: unique,
    original_package_index_sha256: originalDigest,
    selected_amendment_head_sha256: null,
    evaluated_at: evaluatedAt,
  });
}
