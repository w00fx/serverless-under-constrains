// The evidence index that freezes one trial, or the probe (BR-RUA-043, BR-RUA-044, AC-RUA-010;
// design §7 index scopes). It hashes every file under the trial or probe directory by its exact
// bytes, plus the execution-level core files the trial depends on, and excludes itself, the
// late-evidence area and every other trial. Each entry says whether the file is primary or derived.

import { sha256Hex } from '../record-contract/digests.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  Result,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  UtcMillis,
} from '../record-contract/primitives.ts';
import type { EvidenceIndex } from '../record-contract/records/group-c/evidence_index.ts';
import type { IndexEntry } from '../record-contract/records/group-c/shared-shapes.ts';
import { classifyPackageArtifact, invalidPathReason } from './artifact-classification.ts';
import { buildIndexEntries, coreFileMissing, duplicatePathReasons, fileAt } from './index-entries.ts';
import type { PackageFile } from './package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from './package-layout.ts';
import type { EvidenceUnit } from './package-layout.ts';

/** The execution of a trial: a run or a variant validation (a probe has no trial, D-06). */
export type TrialExecution = Exclude<ExecutionIdentity, { readonly execution_kind: 'TRANSPORT_PROBE' }>;

/** What one evidence index freezes: one trial of a run or validation, or the probe. */
export type EvidenceIndexTarget =
  | { readonly index_scope: 'TRIAL'; readonly execution: TrialExecution; readonly trial_id: Uuid4 }
  | { readonly index_scope: 'PROBE'; readonly transport_probe_id: Uuid4 };

export interface EvidenceIndexInput {
  /** Every package file present at freeze; files outside the target's scope are not indexed. */
  readonly files: readonly PackageFile[];
  readonly target: EvidenceIndexTarget;
  readonly created_at: UtcMillis;
}

const MISSING_DIGEST = '0'.repeat(64) as Sha256Hex;

/** Execution-level core files every trial depends on (design §7 index scopes). */
export const TRIAL_CORE_PATHS: readonly string[] = [
  EXECUTION_PATHS.executionManifest,
  EXECUTION_PATHS.environmentInput,
  EXECUTION_PATHS.sourceProvenance,
  EXECUTION_PATHS.oracleRevisionCheck,
  EXECUTION_PATHS.deploymentAssemblyInventory,
  EXECUTION_PATHS.resourceManifest,
];

/** The probe also depends on the coordination prefix checkpoint, never on the open journal (BR-RUA-044). */
export const PROBE_CORE_PATHS: readonly string[] = [...TRIAL_CORE_PATHS, EXECUTION_PATHS.coordinationPrefixCheckpoint];

/**
 * Builds the evidence index of one trial or of the probe, or every reason it cannot be built: an
 * invalid or duplicate path, an unclassifiable file in scope, or a missing core file.
 *
 * @example
 * const index = buildEvidenceIndex({
 *   files,
 *   target: { index_scope: 'TRIAL', execution: { execution_kind: 'RUN', run_id }, trial_id },
 *   created_at,
 * });
 * if (index.ok) await fs.writeOnce(`${dir}/trials/${trial_id}/evidence-index.json`, serializeRecordFile(index.value));
 */
export function buildEvidenceIndex(input: EvidenceIndexInput): Result<EvidenceIndex, readonly StructuredReason[]> {
  const pathReasons = [
    ...duplicatePathReasons(input.files),
    ...input.files.flatMap((file) => invalidPathReason(file.path) ?? []),
  ];
  if (pathReasons.length > 0) {
    return err(pathReasons);
  }
  const unit = unitOf(input.target);
  const core = input.target.index_scope === 'TRIAL' ? TRIAL_CORE_PATHS : PROBE_CORE_PATHS;
  const inScope = input.files.filter((file) => isInScope(file.path, unit, core));
  const reasons: StructuredReason[] = core
    .filter((path) => path !== EXECUTION_PATHS.executionManifest && fileAt(inScope, path) === undefined)
    .map(coreFileMissing);
  const digests: IndexedDigests = {
    execution_manifest_sha256: requiredDigest(inScope, EXECUTION_PATHS.executionManifest, reasons),
    trial_manifest_sha256:
      unit.kind === 'trial'
        ? requiredDigest(inScope, PACKAGE_LAYOUT.unitFile(unit, 'trialManifest'), reasons)
        : MISSING_DIGEST,
  };
  const entries = buildIndexEntries(inScope, classifyPackageArtifact);
  if (!entries.ok || reasons.length > 0) {
    return err([...reasons, ...(entries.ok ? [] : entries.error)]);
  }
  return ok(evidenceIndexRecord(input, entries.value, digests));
}

/**
 * The trial or probe directory an index target freezes.
 *
 * @example
 * unitOf({ index_scope: 'PROBE', transport_probe_id }); // { kind: 'probe' }
 */
export function unitOf(target: EvidenceIndexTarget): EvidenceUnit {
  return target.index_scope === 'TRIAL' ? { kind: 'trial', trial_id: target.trial_id } : { kind: 'probe' };
}

function isInScope(path: string, unit: EvidenceUnit, core: readonly string[]): boolean {
  const inUnit = path.startsWith(`${PACKAGE_LAYOUT.unitDirectory(unit)}/`);
  return inUnit ? path !== PACKAGE_LAYOUT.unitFile(unit, 'evidenceIndex') : core.includes(path);
}

interface IndexedDigests {
  readonly execution_manifest_sha256: Sha256Hex;
  /** The placeholder for the probe, which has no trial manifest (D-06) and never records one. */
  readonly trial_manifest_sha256: Sha256Hex;
}

// The digest of a file the index records by digest; a missing file adds its reason, and the
// all-zero placeholder it returns is never written because the build then fails.
function requiredDigest(files: readonly PackageFile[], path: string, reasons: StructuredReason[]): Sha256Hex {
  const file = fileAt(files, path);
  if (file === undefined) {
    reasons.push(coreFileMissing(path));
    return MISSING_DIGEST;
  }
  return sha256Hex(file.bytes);
}

function evidenceIndexRecord(
  input: EvidenceIndexInput,
  entries: readonly IndexEntry[],
  digests: IndexedDigests,
): EvidenceIndex {
  const base = {
    schema_version: 1 as const,
    record_type: 'evidence_index' as const,
    execution_manifest_sha256: digests.execution_manifest_sha256,
    entries,
    created_at: input.created_at,
  };
  const { target } = input;
  if (target.index_scope === 'PROBE') {
    return { ...base, transport_probe_id: target.transport_probe_id, index_scope: 'PROBE' };
  }
  const trial = {
    trial_id: target.trial_id,
    trial_manifest_sha256: digests.trial_manifest_sha256,
    index_scope: 'TRIAL' as const,
  };
  return target.execution.execution_kind === 'RUN'
    ? { ...base, ...trial, run_id: target.execution.run_id }
    : { ...base, ...trial, variant_validation_id: target.execution.variant_validation_id };
}
