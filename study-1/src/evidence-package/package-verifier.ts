// The package verifier (design §8.16; BR-RUA-043, BR-RUA-044, AC-RUA-022, D-12). It judges the
// structure and integrity of an original package and its explicitly selected amendment chain:
// 1. `package-index.json` parses as this execution's package index (`INDEX_MISSING`);
// 2. every indexed file, and every digest the package records about itself, matches the stored
//    bytes (`ALTERED_BYTES`);
// 3. nothing is stored that the index does not list (`UNINDEXED_FILE`);
// 4. every reference of a derived record resolves (`UNRESOLVED_REFERENCE`); a runner-journal
//    reference may cite a line-boundary prefix of the journal (A-15, reference-resolution.ts);
// 5. the summary exists and its cleanup status is terminal (`NON_TERMINAL_STATUS`);
// 6. the amendment graph is a complete, linear, digest-valid, cycle-free selected chain whose final
//    assessment is not contradictory (amendment-chain.ts, amendment-snapshots.ts);
// 7. `eligible` iff there is no reason.
// Eligibility never implies preservation, implementation, comparison or study-completion success:
// the record has no verdict field, and the verifier never reads a verdict.

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, ExecutionKind, Result, Sha256Hex, UtcMillis } from '../record-contract/primitives.ts';
import type { PackageIndex } from '../record-contract/records/group-c/package_index.ts';
import type {
  PackageEligibilityOutcome,
  PackageIneligibilityReason,
  PackageVerification,
  SelectedChain,
} from '../record-contract/records/group-c/package_verification.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { amendmentLink, resolveAmendmentGraph } from './amendment-chain.ts';
import { finalAssessmentReasons, readAmendments } from './amendment-snapshots.ts';
import type { AmendmentSnapshot } from './amendment-snapshots.ts';
import { belongsToExecution } from './execution-correlation.ts';
import { fileAt } from './index-entries.ts';
import { nestedIndexReasons } from './nested-indexes.ts';
import { parsePackageIndex } from './package-index.ts';
import { fileSetIntegrityReasons, ineligibility } from './package-integrity.ts';
import type { ByteDigest } from './package-integrity.ts';
import type { FsEntry, PackageFile } from './package-file-system.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from './package-layout.ts';
import { parsePackageRecord } from './package-records.ts';
import { unresolvedReferenceReasons } from './reference-resolution.ts';

/** An original package as stored: its regular files and its other entries, relative to its directory. */
export interface PackageSnapshot {
  readonly files: readonly PackageFile[];
  readonly special_entries: readonly FsEntry[];
}

export interface PackageVerificationInput {
  readonly identity: ExecutionIdentity;
  readonly original: PackageSnapshot;
  /** Every amendment directory found for the execution, selected or not. */
  readonly amendments: readonly AmendmentSnapshot[];
  /** The amendment-index digest the operator selected, or `null` for no amendment. */
  readonly selected_head: Sha256Hex | null;
  /** Package-index digests that cross-package references may name. */
  readonly referenced_package_indexes: readonly Sha256Hex[];
  readonly evaluated_at: UtcMillis;
}

/** The services the verifier uses: the catalogue validator and the byte digest (production: `sha256Hex`). */
export interface PackageVerifierDeps {
  readonly validator: RecordValidator;
  readonly digest: ByteDigest;
}

type SummaryRecordType = 'run_summary' | 'transport_probe_summary' | 'validation_summary';

const SUMMARY_RECORD_TYPES: Readonly<Record<ExecutionKind, SummaryRecordType>> = {
  RUN: 'run_summary',
  TRANSPORT_PROBE: 'transport_probe_summary',
  VARIANT_VALIDATION: 'validation_summary',
};
const NON_TERMINAL_CLEANUP: ReadonlySet<string> = new Set(['not_started', 'running']);
const NO_BYTES = new Uint8Array();

/**
 * Verifies a package and its selected amendment chain. Total: every defect is a reason.
 *
 * @example
 * const verification = verifyPackage(
 *   { identity, original, amendments, selected_head: null, referenced_package_indexes: [], evaluated_at },
 *   { validator, digest: sha256Hex },
 * );
 * verification.package_eligibility; // 'eligible' only for a complete noncontradictory chain
 */
export function verifyPackage(input: PackageVerificationInput, deps: PackageVerifierDeps): PackageVerification {
  const { files } = input.original;
  const originalDigest = deps.digest(fileAt(files, EXECUTION_PATHS.packageIndex)?.bytes ?? NO_BYTES);
  const manifestDigest = deps.digest(fileAt(files, EXECUTION_PATHS.executionManifest)?.bytes ?? NO_BYTES);
  const index = readPackageIndex(input, deps.validator);
  const read = readAmendments(PACKAGE_LAYOUT.amendmentsDirectory(input.identity), input.amendments, deps);
  const graph = resolveAmendmentGraph({
    identity: input.identity,
    execution_manifest_sha256: manifestDigest,
    original_package_index_sha256: originalDigest,
    amendments: read.amendments,
    selected_head: input.selected_head,
  });
  const reasons = [
    ...(index.ok ? indexedPackageReasons(index.value, manifestDigest, input, deps) : [index.error]),
    ...summaryReasons(input.identity, files, deps.validator),
    ...read.reasons,
    ...graph.reasons,
    ...finalAssessmentReasons(graph.selected_chain, deps.validator),
  ];
  const selection: SelectedChain =
    input.selected_head === null
      ? { selected_amendment_head_sha256: null, selected_chain: [] }
      : {
          selected_amendment_head_sha256: input.selected_head,
          selected_chain: graph.selected_chain.map(amendmentLink),
        };
  return {
    schema_version: 1,
    record_type: 'package_verification',
    ...executionIdentityFields(input.identity),
    ...eligibilityOutcome(reasons),
    original_package_index_sha256: originalDigest,
    ...selection,
    known_descendants: graph.known_descendants,
    evaluated_at: input.evaluated_at,
  };
}

function readPackageIndex(
  input: PackageVerificationInput,
  validator: RecordValidator,
): Result<PackageIndex, PackageIneligibilityReason> {
  const path = EXECUTION_PATHS.packageIndex;
  const file = fileAt(input.original.files, path);
  const parsed = file === undefined ? undefined : parsePackageIndex(file.bytes, validator);
  if (!parsed?.ok) {
    const problem = parsed === undefined ? 'is absent' : `cannot be read: ${parsed.error.detail}`;
    return {
      ok: false,
      error: ineligibility('INDEX_MISSING', `${path} ${problem}; expected the final package index`, '', path),
    };
  }
  const index = parsed.value;
  if (index.execution_kind !== input.identity.execution_kind || !belongsToExecution(index, input.identity)) {
    return {
      ok: false,
      error: ineligibility(
        'INDEX_MISSING',
        `${path} indexes execution ${boundedJsonText(index.execution_kind)} of another id; expected the index of this execution`,
        '',
        path,
      ),
    };
  }
  return { ok: true, value: index };
}

function indexedPackageReasons(
  index: PackageIndex,
  manifestDigest: Sha256Hex,
  input: PackageVerificationInput,
  deps: PackageVerifierDeps,
): readonly PackageIneligibilityReason[] {
  const manifestPath = EXECUTION_PATHS.executionManifest;
  const manifestReasons =
    index.execution_manifest_sha256 === manifestDigest
      ? []
      : [
          ineligibility(
            'ALTERED_BYTES',
            `package index names execution_manifest_sha256 ${index.execution_manifest_sha256}; the stored ${manifestPath} hashes to ${manifestDigest}`,
            '',
            manifestPath,
          ),
        ];
  return [
    ...manifestReasons,
    ...fileSetIntegrityReasons(
      {
        location: '',
        entries: index.entries,
        files: input.original.files,
        special_entries: input.original.special_entries,
        unlisted: [EXECUTION_PATHS.packageIndex],
      },
      deps.digest,
    ),
    ...nestedIndexReasons(input.original.files, deps),
    ...unresolvedReferenceReasons(
      {
        entries: index.entries,
        files: input.original.files,
        referenced_package_indexes: input.referenced_package_indexes,
      },
      deps.digest,
    ),
  ];
}

function summaryReasons(
  identity: ExecutionIdentity,
  files: readonly PackageFile[],
  validator: RecordValidator,
): readonly PackageIneligibilityReason[] {
  const path = PACKAGE_LAYOUT.summaryPath(identity.execution_kind);
  const file = fileAt(files, path);
  const summary =
    file === undefined
      ? undefined
      : parsePackageRecord(file.bytes, SUMMARY_RECORD_TYPES[identity.execution_kind], validator, path);
  if (!summary?.ok) {
    const problem = summary === undefined ? 'is absent' : `cannot be read: ${summary.error.detail}`;
    return [
      nonTerminal(path, `${problem}; expected the ${SUMMARY_RECORD_TYPES[identity.execution_kind]} of this execution`),
    ];
  }
  if (!belongsToExecution(summary.value, identity)) {
    return [nonTerminal(path, 'names another execution; expected the summary of this execution')];
  }
  const status = summary.value.cleanup_status;
  return NON_TERMINAL_CLEANUP.has(status)
    ? [nonTerminal(path, `has cleanup_status ${status}; expected succeeded, partial or failed`)]
    : [];
}

function nonTerminal(path: string, detail: string): PackageIneligibilityReason {
  return ineligibility('NON_TERMINAL_STATUS', `${path} ${detail}`, '', path);
}

function eligibilityOutcome(reasons: readonly PackageIneligibilityReason[]): PackageEligibilityOutcome {
  const [first, ...rest] = reasons;
  return first === undefined
    ? { package_eligibility: 'eligible', package_ineligibility_reasons: [] }
    : { package_eligibility: 'ineligible', package_ineligibility_reasons: [first, ...rest] };
}
