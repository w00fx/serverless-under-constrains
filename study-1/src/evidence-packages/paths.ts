import { isNormalizedRelativePosixPath } from "../protocol-records/primitives.ts";

export const EVIDENCE_INDEX_PATH = "derived/evidence-index.json";
export const PACKAGE_INDEX_PATH = "package-index.json";
export const LATE_EVIDENCE_AREA = "late-evidence";
export const LATE_EVIDENCE_PREFIX = "late-evidence/";
export const CHECKPOINT_PATH = "primary/coordination/prefix-checkpoint.json";
export const JOURNAL_PATH = "primary/coordination/journal.jsonl";

export function isLateEvidencePath(path: string): boolean {
  return path === LATE_EVIDENCE_AREA || path.startsWith(LATE_EVIDENCE_PREFIX);
}

export function isPackagePath(value: unknown): value is string {
  return isNormalizedRelativePosixPath(value);
}

export function comparePaths(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
