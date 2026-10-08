// The stored package of a usable transport probe whose scope snapshot is the one admission
// recomputes for the same committed project (BR-RUA-026, BR-RUA-028, AC-RUA-051). It starts from
// the WP-10 usable probe package (`probePackage` over the `ac021-probe-verdict-pass` fixture),
// replaces its `admission/transport-scope-snapshot.json` with the snapshot recomputed from the
// given scope ports and the probe's own synthesized template, and rebuilds the package index,
// so the package stays eligible and usable and its selection names the rebuilt index.

import { probeSynthTemplate } from './synth-templates.ts';
import { OR_RUA_002_TIMING, PROVIDER_WARMUP_POLICY, scopeTimingOf } from '../../../src/admission/declared-inputs.ts';
import type { QualificationSelection } from '../../../src/admission/admission-ports.ts';
import { buildPackageIndex } from '../../../src/evidence-package/package-index.ts';
import type { PackageFile } from '../../../src/evidence-package/package-file-system.ts';
import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { serializeRecordFile } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Sha256Hex, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../../../src/record-contract/records/group-a/transport_scope_snapshot.ts';
import { recomputeScopeSnapshot } from '../../../src/transport-qualification/scope/scope-recomputation.ts';
import type { ScopeRecomputationPorts } from '../../../src/transport-qualification/scope/scope-recomputation.ts';
import { loadProbeCase } from '../../golden/transport-qualification/verdict/support/probe-golden.ts';
import { PROBE_IDENTITY, probePackage } from '../../golden/transport-qualification/verdict/support/probe-package.ts';

const INDEX_CREATED_AT = '2026-10-05T12:31:00.000Z' as UtcMillis;

/** The selected probe's stored files, its selection and its snapshot. */
export interface SelectedProbePackage {
  readonly files: readonly PackageFile[];
  readonly selection: QualificationSelection;
  readonly snapshot: TransportScopeSnapshot;
  readonly snapshot_sha256: Sha256Hex;
}

/** The selected probe's id. */
export const SELECTED_PROBE_ID = PROBE_IDENTITY.transport_probe_id;

/**
 * Builds the usable probe package whose snapshot the scope ports recompute.
 *
 * @example
 * const probe = await selectedProbePackage(scopePorts);
 * packages.store(SELECTED_PROBE_ID, probe.files);
 */
export async function selectedProbePackage(scope: ScopeRecomputationPorts): Promise<SelectedProbePackage> {
  const loaded = await loadProbeCase('ac021-probe-verdict-pass');
  const built = probePackage(loaded.files);
  const recomputed = await recomputeScopeSnapshot(
    {
      template: probeSynthTemplate(SELECTED_PROBE_ID),
      runtime: {},
      timing: scopeTimingOf(OR_RUA_002_TIMING),
      provider_warmup: PROVIDER_WARMUP_POLICY,
    },
    scope,
  );
  if (!recomputed.ok) {
    throw new Error(`the probe scope does not recompute: ${JSON.stringify(recomputed.error)}; expected a snapshot`);
  }
  const snapshotFile = { path: EXECUTION_PATHS.transportScopeSnapshot, bytes: serializeRecordFile(recomputed.value) };
  const content = built.files
    .filter((file) => file.path !== EXECUTION_PATHS.packageIndex)
    .map((file) => (file.path === snapshotFile.path ? snapshotFile : file));
  const index = buildPackageIndex({ files: content, identity: PROBE_IDENTITY, created_at: INDEX_CREATED_AT });
  if (!index.ok) {
    throw new Error(`the probe index does not build: ${JSON.stringify(index.error)}; expected an index`);
  }
  const indexFile = { path: EXECUTION_PATHS.packageIndex, bytes: serializeRecordFile(index.value) };
  return {
    files: [...content, indexFile],
    selection: {
      transport_probe_id: SELECTED_PROBE_ID,
      original_package_index_sha256: sha256Hex(indexFile.bytes),
      amendment_head_sha256: null,
    },
    snapshot: recomputed.value,
    snapshot_sha256: sha256Hex(snapshotFile.bytes),
  };
}
