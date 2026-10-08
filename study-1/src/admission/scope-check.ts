// Admission step A13 (QUALIFICATION; BR-RUA-028, AC-RUA-051, design §10.1): the transport-scope
// snapshot of the execution being admitted, recomputed from the committed source, the bundler's
// closure, the installed packages, the synthesized template, the declared timing and the warm-up
// policy. A probe freezes the snapshot it creates. A run or a validation must recompute exactly
// the selected probe's snapshot: any scoped drift (source, dependency, lockfile, configuration,
// runtime property, timing, warm-up or policy) rejects it, while a change outside the scope, such
// as an oracle source file, leaves the snapshot and the qualification intact.

import type { Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { TransportScopeSnapshot } from '../record-contract/records/group-a/transport_scope_snapshot.ts';
import { compareScopeSnapshots } from '../transport-qualification/scope/scope-drift.ts';
import { recomputeScopeSnapshot } from '../transport-qualification/scope/scope-recomputation.ts';
import type {
  ScopeEnvironment,
  ScopeRecomputationPorts,
} from '../transport-qualification/scope/scope-recomputation.ts';
import { scopeSnapshotSha256 } from '../transport-qualification/scope/scope-snapshot.ts';
import { admissionReason } from './admission-reason.ts';
import { failedWithAll, passed } from './preflight-check.ts';
import type { CheckStatement, StepVerdict } from './preflight-check.ts';
import type { SelectedProbe } from './qualification-check.ts';

/** The snapshot the manifest freezes and its record-file digest. */
export interface AdmittedScope {
  readonly snapshot: TransportScopeSnapshot;
  readonly sha256: Sha256Hex;
}

/**
 * Step A13: recompute, then compare with the selected probe's snapshot when there is one.
 *
 * @example
 * const verdict = await assessTransportScope(environment, scopePorts, selectedProbe);
 * if (verdict.passed) verdict.value.sha256; // equal to the selected probe's snapshot digest
 */
export async function assessTransportScope(
  environment: ScopeEnvironment,
  ports: ScopeRecomputationPorts,
  selected: SelectedProbe | null,
): Promise<StepVerdict<AdmittedScope>> {
  const statement: CheckStatement = {
    subject: 'transport_scope_snapshot',
    expected: selected === null ? 'recomputable_snapshot' : selected.snapshot_sha256,
  };
  const recomputed = await recomputeScopeSnapshot(environment, ports);
  if (!recomputed.ok) {
    return failedWithAll(
      'QUALIFICATION',
      statement,
      recomputed.error,
      scopeReason('SCOPE_NOT_RECOMPUTED', 'the snapshot could not be recomputed; expected a recomputable snapshot'),
    );
  }
  const sha256 = scopeSnapshotSha256(recomputed.value);
  const observed: CheckStatement = { ...statement, observed: sha256 };
  if (selected === null) {
    return passed({ snapshot: recomputed.value, sha256 }, observed);
  }
  const drift = compareScopeSnapshots(selected.snapshot, recomputed.value);
  if (drift.status === 'drift') {
    return failedWithAll(
      'QUALIFICATION',
      observed,
      drift.reasons,
      scopeReason(
        'SCOPE_SNAPSHOT_CHANGED',
        'the recomputed snapshot differs from the selected one; expected an identical snapshot',
      ),
    );
  }
  return passed({ snapshot: recomputed.value, sha256 }, observed);
}

function scopeReason(code: string, detail: string): StructuredReason {
  return admissionReason(code, 'BR-RUA-028', detail);
}
