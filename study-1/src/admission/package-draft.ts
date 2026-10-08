// The admitted package's `admission/` directory (BR-RUA-040, BR-RUA-042, design §7, §9.8 S2, §10.1
// A15). Every record is built and validated against its schema before the first byte is written,
// so a draft never holds a record its own catalogue would refuse. The files are then written
// once each: the record files and schema copies, the frozen assembly copy (re-inventoried and
// required to equal the staging inventory, else nothing more is written), its inventory, the
// attempt journal, and the execution manifest last. The manifest is the commit point: a package
// without it was never admitted.

import { join } from 'node:path';

import { canonicalJsonIfRepresentable, serializeRecordFile } from '../record-contract/canonical-json.ts';
import { sha256Hex } from '../record-contract/digests.ts';
import { boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { RecordType } from '../record-contract/record-types.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { StudyRecord } from '../record-contract/records/index.ts';
import type { AssemblyFileSystem } from '../deployment-assembly/assembly-file-system.ts';
import { inventoryAssembly } from '../evidence-package/assembly-inventory.ts';
import type { PackageFile } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../evidence-package/package-layout.ts';
import { admissionReason } from './admission-reason.ts';
import { copyAssemblyDirectory, readAssemblyDirectory } from './assembly-files.ts';
import type { SynthesizedAssembly } from './assembly-freeze.ts';

const SUBJECT = 'BR-RUA-040';
const RECORD_FILE_MODE = 0o644;
const VIOLATIONS_QUOTED = 3;

/** One record the draft holds, at its package path. */
export interface DraftRecord {
  readonly path: string;
  readonly record_type: RecordType;
  readonly record: StudyRecord;
}

/** The validated bytes of a draft: record files, exact byte copies and the manifest. */
export interface DraftFiles {
  readonly files: readonly PackageFile[];
  readonly manifest_bytes: Uint8Array;
  readonly manifest_sha256: Sha256Hex;
}

/**
 * Serializes and validates every record of the draft; the error lists each invalid record.
 *
 * @example
 * const draft = draftFiles(records, copies, manifest, validator);
 * if (draft.ok) draft.value.manifest_sha256;
 */
export function draftFiles(
  records: readonly DraftRecord[],
  copies: readonly PackageFile[],
  manifest: ExecutionManifest,
  validator: RecordValidator,
): Result<DraftFiles, readonly StructuredReason[]> {
  const checked = records.map((draft) => checkedRecordFile(draft, validator));
  const manifestFile = checkedRecordFile(
    { path: EXECUTION_PATHS.executionManifest, record_type: 'execution_manifest', record: manifest },
    validator,
  );
  const invalid = [...checked, manifestFile].flatMap((file) => (file.ok ? [] : file.error));
  const written = checked.flatMap((file) => (file.ok ? [file.value] : []));
  if (!manifestFile.ok || invalid.length > 0) {
    return err(invalid);
  }
  return ok({
    files: [...copies, ...written],
    manifest_bytes: manifestFile.value.bytes,
    manifest_sha256: sha256Hex(manifestFile.value.bytes),
  });
}

/**
 * The record-file digest a manifest names for a record the draft will hold.
 *
 * @example
 * recordFileSha256(sourceProvenance); // digest of its canonical file bytes
 */
export function recordFileSha256(record: StudyRecord): Sha256Hex {
  return sha256Hex(serializeRecordFile(record));
}

export interface DraftWrite {
  readonly evidence_root: string;
  readonly identity: ExecutionIdentity;
  readonly draft: DraftFiles;
  readonly assembly: SynthesizedAssembly;
  /** The attempt journal's exact bytes, every step through A15 included. */
  readonly journal_bytes: Uint8Array;
}

/**
 * Writes the draft; `undefined` when every file, the manifest last, is written.
 *
 * @example
 * const problem = await writePackageDraft({ evidence_root, identity, draft, assembly, journal_bytes }, files);
 */
export async function writePackageDraft(
  write: DraftWrite,
  files: AssemblyFileSystem,
): Promise<StructuredReason | undefined> {
  const root = join(write.evidence_root, PACKAGE_LAYOUT.executionDirectory(write.identity));
  const written = await writeFiles(root, write.draft.files, files);
  if (written !== undefined) {
    return written;
  }
  // The inventory's own path (`admission/deployment-assembly`), so the copy is where it says it is.
  const frozen = await freezeAssemblyCopy(join(root, write.assembly.inventory.assembly_path), write.assembly, files);
  if (frozen !== undefined) {
    return frozen;
  }
  return writeFiles(
    root,
    [
      { path: EXECUTION_PATHS.deploymentAssemblyInventory, bytes: serializeRecordFile(write.assembly.inventory) },
      { path: EXECUTION_PATHS.preflightJournal, bytes: write.journal_bytes },
      { path: EXECUTION_PATHS.executionManifest, bytes: write.draft.manifest_bytes },
    ],
    files,
  );
}

async function writeFiles(
  root: string,
  draftFiles: readonly PackageFile[],
  files: AssemblyFileSystem,
): Promise<StructuredReason | undefined> {
  for (const file of draftFiles) {
    const written = await files.createFile(join(root, file.path), file.bytes, RECORD_FILE_MODE);
    if (!written.ok) {
      return admissionReason(
        'PACKAGE_DRAFT_UNWRITABLE',
        SUBJECT,
        `writing ${boundedText(file.path)} failed with ${written.error.code}: ${boundedText(written.error.detail)}; expected a new file`,
      );
    }
  }
  return undefined;
}

// S2 then the proof: the package copy must inventory to exactly the staging inventory.
async function freezeAssemblyCopy(
  target: string,
  assembly: SynthesizedAssembly,
  files: AssemblyFileSystem,
): Promise<StructuredReason | undefined> {
  const copied = await copyAssemblyDirectory(assembly.directory, target, files);
  if (copied !== undefined) {
    return copied;
  }
  const reread = await readAssemblyDirectory(files, target);
  if (!reread.ok) {
    return reread.error;
  }
  const inventory = inventoryAssembly({
    assembly_path: assembly.inventory.assembly_path,
    entries: reread.value.entries,
    files: reread.value.files,
    inventoried_at: assembly.inventory.inventoried_at,
  });
  const copyDigest = inventory.ok ? inventory.value.inventory_sha256 : 'not inventoried';
  return copyDigest === assembly.inventory.inventory_sha256
    ? undefined
    : admissionReason(
        'FROZEN_ASSEMBLY_NOT_IDENTICAL',
        'BR-RUA-042',
        `the package copy inventories to ${copyDigest}; expected the staging inventory ${assembly.inventory.inventory_sha256}`,
      );
}

// The bytes written are the bytes validated: the canonical file is parsed back and checked.
function checkedRecordFile(
  draft: DraftRecord,
  validator: RecordValidator,
): Result<PackageFile, readonly StructuredReason[]> {
  const text = canonicalJsonIfRepresentable(draft.record);
  const bytes = new TextEncoder().encode(`${text ?? ''}\n`);
  const parsed = parseJsonDocument(bytes);
  const validation = parsed.ok ? validator.validateAs(draft.record_type, parsed.value) : undefined;
  if (validation?.valid === true) {
    return ok({ path: draft.path, bytes });
  }
  const violations = validation?.violations ?? [
    { instance_path: '', keyword: 'json', detail: 'not representable as JSON' },
  ];
  return err(
    violations
      .slice(0, VIOLATIONS_QUOTED)
      .map((violation) =>
        admissionReason(
          'DRAFT_RECORD_INVALID',
          SUBJECT,
          `${draft.path} at ${boundedText(violation.instance_path === '' ? '/' : violation.instance_path)} violates ${violation.keyword}: ${violation.detail}`,
        ),
      ),
  );
}
