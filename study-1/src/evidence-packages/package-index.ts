import type { IndexEntry, PackageIndexRecord } from "./types.ts";
import { isPackageStore, storeBytes } from "./store.ts";
import { entryOf, sortByPath, writeIndexFile } from "./entries.ts";
import { EVIDENCE_INDEX_PATH, PACKAGE_INDEX_PATH, isPackagePath } from "./paths.ts";
import { fail, ok, type ValidationResult } from "./result.ts";

export function writePackageIndex(store: unknown): ValidationResult<PackageIndexRecord> {
  if (!isPackageStore(store)) {
    return fail(["not_an_object"]);
  }
  if (store.has(PACKAGE_INDEX_PATH)) {
    return fail(["rewrite_forbidden"]);
  }
  if (storeBytes(store, EVIDENCE_INDEX_PATH) === undefined) {
    return fail(["missing_evidence_index"]);
  }
  const reasons: string[] = [];
  const entries: IndexEntry[] = [];
  for (const path of store.keys()) {
    if (!isPackagePath(path) || path === PACKAGE_INDEX_PATH) {
      reasons.push("invalid_path");
      continue;
    }
    const bytes = storeBytes(store, path);
    if (bytes === undefined) {
      reasons.push("invalid_path");
      continue;
    }
    entries.push(entryOf(path, bytes));
  }
  if (reasons.length > 0) {
    return fail(reasons);
  }
  const record: PackageIndexRecord = {
    schema_version: 1,
    record_type: "package_index",
    entries: sortByPath(entries),
  };
  writeIndexFile(store, PACKAGE_INDEX_PATH, record);
  return ok(record);
}
