// Byte integrity of one indexed file set (design §8.16 steps 2-3): every entry's file exists with
// the indexed byte count and digest (`ALTERED_BYTES`), and no file or non-regular entry exists that
// the index does not list (`UNINDEXED_FILE`). The original package and every amendment share it.
// The digest is injected so a test can alias two byte strings to one digest (the CYCLE fixture);
// production passes the kernel's `sha256Hex`.

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { Sha256Hex } from '../record-contract/primitives.ts';
import type { PackageIneligibilityReason } from '../record-contract/records/group-c/package_verification.ts';
import type { IndexEntry } from '../record-contract/records/group-c/shared-shapes.ts';
import type { PackageIneligibilityCode } from '../record-contract/records/group-c/vocabulary.ts';
import { invalidPathReason } from './artifact-classification.ts';
import type { FsEntry, PackageFile } from './package-file-system.ts';

/** The digest the verifier applies to stored bytes. */
export type ByteDigest = (bytes: Uint8Array) => Sha256Hex;

/** One indexed file set: the index entries, the stored files and the entries that are not files. */
export interface IndexedFileSet {
  /** Shown before every path in a reason, for example `amendments/<id>/0001-<a>/`; `''` for the package. */
  readonly location: string;
  readonly entries: readonly IndexEntry[];
  readonly files: readonly PackageFile[];
  /** Symlinks, devices and other non-regular entries found under the root. */
  readonly special_entries: readonly FsEntry[];
  /** Files the index cannot list, such as the index itself. */
  readonly unlisted: readonly string[];
}

const SUBJECT = 'BR-RUA-044';

/**
 * Every `ALTERED_BYTES` and `UNINDEXED_FILE` reason of one indexed file set.
 *
 * @example
 * fileSetIntegrityReasons({ location: '', entries: index.entries, files, special_entries: [], unlisted: ['package-index.json'] }, sha256Hex);
 */
export function fileSetIntegrityReasons(
  set: IndexedFileSet,
  digest: ByteDigest,
): readonly PackageIneligibilityReason[] {
  const byPath = new Map(set.files.map((file) => [file.path, file]));
  const listed = new Set([...set.entries.map((entry) => entry.artifact_path), ...set.unlisted]);
  const altered = set.entries.flatMap((entry) =>
    alteredEntryReason(set.location, entry, byPath.get(entry.artifact_path), digest),
  );
  const unindexedFiles = set.files.filter((file) => !listed.has(file.path)).map((file) => file.path);
  const unindexed = [...unindexedFiles, ...set.special_entries.map((entry) => entry.path)].map((path) =>
    ineligibility(
      'UNINDEXED_FILE',
      `${shown(set.location, path)} is not listed by the index; expected every stored entry to be an indexed regular file`,
      set.location,
      path,
    ),
  );
  return [...altered, ...unindexed];
}

/**
 * The reason one entry does not match its stored file, or nothing when it does.
 *
 * @example
 * alteredEntryReason('', entry, fileAt(files, entry.artifact_path), sha256Hex); // [] when intact
 */
export function alteredEntryReason(
  location: string,
  entry: Pick<IndexEntry, 'artifact_path' | 'bytes' | 'sha256'>,
  file: PackageFile | undefined,
  digest: ByteDigest,
): readonly PackageIneligibilityReason[] {
  const path = entry.artifact_path;
  if (file === undefined) {
    return [
      ineligibility(
        'ALTERED_BYTES',
        `${shown(location, path)} is indexed but absent; expected the indexed file`,
        location,
        path,
      ),
    ];
  }
  const actual = digest(file.bytes);
  if (file.bytes.length === entry.bytes && actual === entry.sha256) {
    return [];
  }
  const detail = `${shown(location, path)} has ${String(file.bytes.length)} bytes with sha256 ${actual}; expected ${String(entry.bytes)} bytes with sha256 ${entry.sha256}`;
  return [ineligibility('ALTERED_BYTES', detail, location, path)];
}

/**
 * A package-ineligibility reason. `artifact_path` is set only for a valid path inside the original
 * package (`location` empty), because the field names a package-relative path (BR-RUA-035).
 *
 * @example
 * ineligibility('INDEX_MISSING', 'package-index.json is absent; expected the final package index', '', 'package-index.json');
 */
export function ineligibility(
  code: PackageIneligibilityCode,
  detail: string,
  location: string,
  path?: string,
): PackageIneligibilityReason {
  const reason = { code, subject: SUBJECT, detail };
  if (path === undefined || location !== '' || invalidPathReason(path) !== undefined) {
    return reason;
  }
  return { ...reason, artifact_path: path };
}

function shown(location: string, path: string): string {
  return boundedJsonText(`${location}${path}`);
}
