import { isNormalizedRelativePosixPath } from "../protocol-records/primitives.ts";

export const EVIDENCE_INDEX_PATH = "derived/evidence-index.json";
export const PACKAGE_INDEX_PATH = "package-index.json";
export const LATE_EVIDENCE_AREA = "late-evidence";
export const LATE_EVIDENCE_PREFIX = "late-evidence/";
export const CHECKPOINT_PATH = "primary/coordination/prefix-checkpoint.json";
export const JOURNAL_PATH = "primary/coordination/journal.jsonl";

export function isPackagePath(value: unknown): value is string {
  return isNormalizedRelativePosixPath(value);
}

export function isLateEvidencePath(path: string): boolean {
  return path === LATE_EVIDENCE_AREA || path.startsWith(LATE_EVIDENCE_PREFIX);
}

export function isExcludedFromEvidenceIndex(path: string, hasCheckpoint: boolean): boolean {
  return (
    isLateEvidencePath(path) ||
    path === EVIDENCE_INDEX_PATH ||
    path === PACKAGE_INDEX_PATH ||
    (hasCheckpoint && path === JOURNAL_PATH)
  );
}

export function isEvidenceIndexedPath(path: string, hasCheckpoint: boolean): boolean {
  return isPackagePath(path) && !isExcludedFromEvidenceIndex(path, hasCheckpoint);
}

export function comparePaths(left: string, right: string): number {
  return Number(left > right) - Number(left < right);
}
