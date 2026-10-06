// The BR-RUA-054 provenance condition of study completion: the run executed "from clean committed
// final source and a matching transport qualification" (BR-RUA-042, BR-RUA-028). The original
// package's source provenance must be the one the execution manifest froze, and the manifest's
// qualification must be exactly the probe the operator selected, with the same transport-scope
// snapshot.

import type { Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type {
  ExecutionManifest,
  SelectedQualification,
} from '../record-contract/records/group-a/execution_manifest.ts';
import type { SourceProvenance } from '../record-contract/records/group-a/source_provenance.ts';
import { EXECUTION_PATHS } from '../evidence-package/package-layout.ts';
import { comparisonReason } from './comparison-reasons.ts';
import type { FrozenRecord } from './record-files.ts';

/** The probe qualification the operator selected for the run, and its transport-scope snapshot. */
export interface SelectedRunQualification {
  readonly qualification: SelectedQualification;
  readonly transport_scope_snapshot_sha256: Sha256Hex;
}

/**
 * Why the source the run executed from is not shown clean and committed; empty when it is.
 *
 * @example
 * sourceReasons(manifest, provenance); // [] when the stored provenance is the one the manifest froze
 */
export function sourceReasons(
  manifest: FrozenRecord<ExecutionManifest> | undefined,
  provenance: FrozenRecord<SourceProvenance> | undefined,
): readonly StructuredReason[] {
  if (manifest === undefined) {
    return [manifestMissing()];
  }
  const path = EXECUTION_PATHS.sourceProvenance;
  if (provenance === undefined) {
    return [
      comparisonReason(
        'ARTIFACT_MISSING',
        'source_provenance',
        `${path} is absent or unreadable; expected the frozen source provenance`,
        path,
      ),
    ];
  }
  const declared = manifest.record.source;
  const mismatches: readonly (readonly [string, string, string])[] = [
    ['source_provenance_sha256', provenance.ref.artifact_sha256, declared.source_provenance_sha256],
    ['commit_sha', provenance.record.commit_sha, declared.commit_sha],
    ['tree_sha', provenance.record.tree_sha, declared.tree_sha],
  ];
  return mismatches
    .filter(([, stored, frozen]) => stored !== frozen)
    .map(([field, stored, frozen]) =>
      comparisonReason(
        'SOURCE_NOT_CLEAN',
        field,
        `${path} gives ${field} ${stored}; the execution manifest froze ${frozen}`,
        path,
      ),
    );
}

/**
 * Why the run's qualification is not the selected one; empty when it matches exactly.
 *
 * @example
 * qualificationReasons(manifest, { qualification, transport_scope_snapshot_sha256 }); // []
 */
export function qualificationReasons(
  manifest: FrozenRecord<ExecutionManifest> | undefined,
  selected: SelectedRunQualification | undefined,
): readonly StructuredReason[] {
  if (manifest === undefined) {
    return [manifestMissing()];
  }
  const frozen = manifest.record.qualification;
  if (selected === undefined || frozen === null) {
    const missingSide =
      selected === undefined
        ? 'no transport qualification was selected'
        : 'the execution manifest names no qualification';
    return [mismatch('qualification', `${missingSide}; expected the run's qualification to be the selected probe`)];
  }
  const wanted = selected.qualification;
  const fields: readonly (readonly [string, string | null, string | null])[] = [
    ['transport_probe_id', frozen.transport_probe_id, wanted.transport_probe_id],
    ['original_package_index_sha256', frozen.original_package_index_sha256, wanted.original_package_index_sha256],
    ['amendment_head_sha256', frozen.amendment_head_sha256 ?? null, wanted.amendment_head_sha256 ?? null],
    [
      'transport_scope_snapshot_sha256',
      manifest.record.transport_scope_snapshot_sha256,
      selected.transport_scope_snapshot_sha256,
    ],
  ];
  return fields
    .filter(([, run, chosen]) => run !== chosen)
    .map(([field, run, chosen]) =>
      mismatch(
        field,
        `the execution manifest froze ${field} ${String(run)}; the selected qualification has ${String(chosen)}`,
      ),
    );
}

function mismatch(subject: string, detail: string): StructuredReason {
  return comparisonReason('QUALIFICATION_MISMATCH', subject, detail, EXECUTION_PATHS.executionManifest);
}

function manifestMissing(): StructuredReason {
  const path = EXECUTION_PATHS.executionManifest;
  return comparisonReason(
    'ARTIFACT_MISSING',
    'execution_manifest',
    `${path} is absent or unreadable; expected the frozen execution manifest`,
    path,
  );
}
