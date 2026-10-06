// The canonical inventory of the frozen deployment assembly (BR-RUA-042; design §9.8 S3). It
// lists every regular file of the assembly copy inside the package, sorted by normalized relative
// path in code-point order, with its byte count, permission bits and digest; `inventory_sha256` is
// the digest of the canonical JSON of that list. The PoC rejects symlinks, special files and
// container-image assets, and (RK-12) any bundled `.mjs` that imports `@aws-sdk/*` from the
// runtime instead of bundling the lockfile version. The bundle is read as JavaScript tokens, never
// as text, because the SDK's own error messages quote such imports (A-14 fix, 2026-10-06).

import { canonicalJson } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type {
  AssemblyFileEntry,
  DeploymentAssemblyInventory,
} from '../record-contract/records/group-a/deployment_assembly_inventory.ts';
import { invalidPathReason } from './artifact-classification.ts';
import { loadsBareAwsSdk } from './bundle-module-loads.ts';
import { containerAssetFindings } from './container-assets.ts';
import { duplicatePathReasons } from './index-entries.ts';
import type { FsEntry, PackageFile } from './package-file-system.ts';

export interface AssemblyInventoryInput {
  /** Package-relative directory of the frozen copy, for example `admission/deployment-assembly`. */
  readonly assembly_path: string;
  /** Every `lstat` entry below the assembly root, paths relative to it. */
  readonly entries: readonly FsEntry[];
  /** The bytes of every regular file, paths relative to the assembly root. */
  readonly files: readonly PackageFile[];
  readonly inventoried_at: UtcMillis;
}

const PERMISSION_BITS = 0o7777;
const SURROGATE_START = 0xd800;
const PRIVATE_USE_START = 0xe000;
const BUNDLE_SUFFIX = '.mjs';
const textDecoder = new TextDecoder('utf-8');

/**
 * Inventories the assembly copy, or returns every reason the PoC rejects it.
 *
 * @example
 * const inventory = inventoryAssembly({ assembly_path: 'admission/deployment-assembly', entries, files, inventoried_at });
 * if (!inventory.ok) return rejectAdmission(inventory.error);
 */
export function inventoryAssembly(
  input: AssemblyInventoryInput,
): Result<DeploymentAssemblyInventory, readonly StructuredReason[]> {
  const reasons = [
    ...pathReasons(input),
    ...entryReasons(input),
    ...containerAssetFindings(input.files),
    ...input.files.flatMap(bareSdkImportReason),
  ];
  const listed = assemblyFileEntries(input);
  const [first, ...rest] = listed;
  if (reasons.length > 0 || first === undefined) {
    return err(
      reasons.length > 0
        ? reasons
        : [assemblyReason('EMPTY_ASSEMBLY', 'the assembly has no regular file; expected a synthesized cloud assembly')],
    );
  }
  const files: DeploymentAssemblyInventory['files'] = [first, ...rest];
  return ok({
    schema_version: 1,
    record_type: 'deployment_assembly_inventory',
    assembly_path: input.assembly_path,
    files,
    inventory_sha256: inventoryDigest(files),
    inventoried_at: input.inventoried_at,
  });
}

/**
 * The digest of the canonical JSON of an inventory's file list (no trailing newline).
 *
 * @example
 * inventoryDigest(inventory.files) === inventory.inventory_sha256; // true for an intact inventory
 */
export function inventoryDigest(files: readonly AssemblyFileEntry[]): ReturnType<typeof sha256Hex> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(files.map((file) => ({ ...file })))));
}

/**
 * Orders strings by Unicode code point, the order the inventory sorts its paths by (BR-RUA-042).
 * It differs from UTF-16 code-unit order only for characters outside the Basic Multilingual Plane.
 *
 * @example
 * ['\u{1F600}', '｡'].toSorted(compareCodePoints); // ['｡', '\u{1F600}']
 */
export function compareCodePoints(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.charCodeAt(index);
    const right = b.charCodeAt(index);
    if (left !== right) {
      return codePointRank(left, right) - codePointRank(right, left);
    }
  }
  return a.length - b.length;
}

// UTF-16 code-unit order already is code-point order except that a surrogate (U+D800-U+DFFF,
// part of a code point above U+FFFF) must sort after U+E000-U+FFFF. When both units are at or
// above U+D800, surrogates move up by 0x2000 and the rest down by 0x800, which restores it.
function codePointRank(unit: number, other: number): number {
  if (unit < SURROGATE_START || other < SURROGATE_START) {
    return unit;
  }
  return unit >= PRIVATE_USE_START ? unit - 0x800 : unit + 0x2000;
}

/**
 * Formats `stat.mode` permission bits as four octal digits, for example `0644`.
 *
 * @example
 * permissionDigits(0o100644); // '0644'
 */
export function permissionDigits(mode: number): string {
  return (mode & PERMISSION_BITS).toString(8).padStart(4, '0');
}

function pathReasons(input: AssemblyInventoryInput): readonly StructuredReason[] {
  const assembly = invalidPathReason(input.assembly_path);
  const paths = [...input.entries.map((entry) => entry.path), ...input.files.map((file) => file.path)];
  return [
    ...(assembly === undefined ? [] : [assembly]),
    ...[...new Set(paths)].flatMap((path) => invalidPathReason(path) ?? []),
    ...duplicatePathReasons(input.files),
  ];
}

function entryReasons(input: AssemblyInventoryInput): readonly StructuredReason[] {
  const filePaths = new Set(input.files.map((file) => file.path));
  const regular = new Set(input.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path));
  const special = input.entries
    .filter((entry) => entry.type !== 'file' && entry.type !== 'directory')
    .map((entry) =>
      assemblyReason(
        'NON_REGULAR_FILE',
        `${boundedJsonText(entry.path)} is a ${entry.type}; expected only regular files and directories`,
      ),
    );
  const unread = [...regular]
    .filter((path) => !filePaths.has(path))
    .map((path) =>
      assemblyReason(
        'FILE_BYTES_MISSING',
        `${boundedJsonText(path)} is listed but its bytes were not read; expected the bytes of every regular file`,
      ),
    );
  const unlisted = [...filePaths]
    .filter((path) => !regular.has(path))
    .map((path) =>
      assemblyReason(
        'FILE_NOT_LISTED',
        `${boundedJsonText(path)} has bytes but no regular-file entry; expected the listing to name it`,
      ),
    );
  return [...special, ...unread, ...unlisted];
}

function bareSdkImportReason(file: PackageFile): readonly StructuredReason[] {
  if (!file.path.endsWith(BUNDLE_SUFFIX) || !loadsBareAwsSdk(textDecoder.decode(file.bytes))) {
    return [];
  }
  return [
    assemblyReason(
      'BARE_AWS_SDK_IMPORT',
      `bundle ${boundedJsonText(file.path)} imports a bare '@aws-sdk/' specifier; expected every SDK module bundled from the lockfile (RK-12)`,
    ),
  ];
}

function assemblyFileEntries(input: AssemblyInventoryInput): readonly AssemblyFileEntry[] {
  const modes = new Map(input.entries.map((entry) => [entry.path, entry.mode]));
  return input.files
    .map((file) => ({
      path: file.path,
      bytes: file.bytes.length,
      mode: permissionDigits(modes.get(file.path) ?? 0),
      sha256: sha256Hex(file.bytes),
    }))
    .toSorted((a, b) => compareCodePoints(a.path, b.path));
}

/**
 * A rejection reason of the inventory builder (BR-RUA-042).
 *
 * @example
 * assemblyReason('NON_REGULAR_FILE', 'x is a symlink; expected only regular files');
 */
export function assemblyReason(code: string, detail: string): StructuredReason {
  return { code, subject: 'BR-RUA-042', detail };
}
