// Index entries shared by the evidence, package and amendment indexes (design §7): one entry per
// file with its class, derivation, exact byte count and the SHA-256 of the exact stored bytes
// (BR-RUA-033), sorted by `artifact_path`. A duplicate or unclassifiable path fails the build, so
// no file is ever dropped or listed twice silently.

import { sha256Hex } from '../record-contract/digests.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { IndexEntry } from '../record-contract/records/group-c/shared-shapes.ts';
import type { ArtifactClassification } from './artifact-classification.ts';
import { invalidPathReason } from './artifact-classification.ts';
import type { PackageFile } from './package-file-system.ts';

/** Classifies one path, or explains why it cannot be indexed. */
export type ArtifactClassifier = (path: string) => Result<ArtifactClassification, StructuredReason>;

/**
 * Builds the sorted entries of `files`, or every reason the set cannot be indexed: each duplicate
 * path and each path the classifier refuses.
 *
 * @example
 * const entries = buildIndexEntries(files, classifyPackageArtifact);
 * if (entries.ok) index.entries = entries.value;
 */
export function buildIndexEntries(
  files: readonly PackageFile[],
  classify: ArtifactClassifier,
): Result<readonly IndexEntry[], readonly StructuredReason[]> {
  const reasons: StructuredReason[] = [...duplicatePathReasons(files)];
  const entries: IndexEntry[] = [];
  for (const file of files) {
    const classified = classify(file.path);
    if (!classified.ok) {
      reasons.push(classified.error);
      continue;
    }
    entries.push({
      artifact_path: file.path,
      artifact_class: classified.value.artifact_class,
      derivation: classified.value.derivation,
      bytes: file.bytes.length,
      sha256: sha256Hex(file.bytes),
    });
  }
  return reasons.length > 0 ? err(reasons) : ok(entries.toSorted(compareEntryPaths));
}

/**
 * One reason per path that occurs more than once, so a caller can refuse a file set before
 * reading anything out of it.
 *
 * @example
 * duplicatePathReasons([{ path: 'a', bytes }, { path: 'a', bytes }]).length; // 1
 */
export function duplicatePathReasons(files: readonly PackageFile[]): readonly StructuredReason[] {
  const seen = new Set<string>();
  const reported = new Set<string>();
  const reasons: StructuredReason[] = [];
  for (const { path } of files) {
    if (seen.has(path) && !reported.has(path)) {
      reported.add(path);
      reasons.push(duplicateReason(path));
    }
    seen.add(path);
  }
  return reasons;
}

/**
 * Orders entries by `artifact_path` in UTF-16 code units, the canonical order the catalogue's
 * `x-rua-evidence-ref-order` keyword checks on every index.
 *
 * @example
 * entries.toSorted(compareEntryPaths);
 */
export function compareEntryPaths(
  a: { readonly artifact_path: string },
  b: { readonly artifact_path: string },
): number {
  if (a.artifact_path === b.artifact_path) {
    return 0;
  }
  return a.artifact_path < b.artifact_path ? -1 : 1;
}

/**
 * The file at `path`, or `undefined` when the set has none.
 *
 * @example
 * fileAt(files, 'admission/execution-manifest.json')?.bytes;
 */
export function fileAt(files: readonly PackageFile[], path: string): PackageFile | undefined {
  return files.find((file) => file.path === path);
}

/**
 * The reason an index cannot be built without a file whose digest it records.
 *
 * @example
 * coreFileMissing('admission/execution-manifest.json').code; // 'CORE_FILE_MISSING'
 */
export function coreFileMissing(path: string): StructuredReason {
  return {
    code: 'CORE_FILE_MISSING',
    subject: 'BR-RUA-044',
    artifact_path: path,
    detail: `${boundedJsonText(path)} is absent; expected it among the indexed files`,
  };
}

function duplicateReason(path: string): StructuredReason {
  const base = {
    code: 'DUPLICATE_ARTIFACT_PATH',
    subject: 'BR-RUA-044',
    detail: `path ${boundedJsonText(path)} occurs more than once; expected each file once`,
  };
  return invalidPathReason(path) === undefined ? { ...base, artifact_path: path } : base;
}
