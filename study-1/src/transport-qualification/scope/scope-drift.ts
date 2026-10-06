// Qualification drift (BR-RUA-028, AC-RUA-051): admission recomputes the selected probe's
// scope against current committed source and compares the two snapshots. Any difference is
// scoped drift, which rejects the attempt before manifest freeze and requires a new probe.
//
// Equality is decided on the canonical snapshot bytes, so nothing can differ unnoticed; the
// itemized differences only explain the rejection. A difference no field comparison names
// (for example a non-canonical collection order) is still drift, reported as a whole.

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import type { JsonValue, Sha256Hex, StructuredReason } from '../../record-contract/primitives.ts';
import type {
  ScopeTimingValues,
  TransportScopeSnapshot,
} from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import { sortedCodeUnits } from './bundle-inputs.ts';
import { projectedResourceJson } from './configuration-projection.ts';
import { SCOPE_REASON_SUBJECT } from './scope-reasons.ts';
import { SCOPE_TIMING_KEYS, scopeSnapshotSha256 } from './scope-snapshot.ts';

export const SCOPE_DRIFT_CODES = [
  'SCOPE_POLICY_CHANGED',
  'SCOPE_ENTRY_POINTS_CHANGED',
  'SCOPED_SOURCE_CHANGED',
  'SCOPED_DEPENDENCY_CHANGED',
  'SCOPED_LOCKFILE_CHANGED',
  'SCOPED_CONFIGURATION_CHANGED',
  'SCOPED_RUNTIME_PROPERTY_CHANGED',
  'SCOPED_TIMING_CHANGED',
  'SCOPED_WARMUP_POLICY_CHANGED',
  'SCOPE_SNAPSHOT_CHANGED',
] as const;
export type ScopeDriftCode = (typeof SCOPE_DRIFT_CODES)[number];

/** One difference; `null` stands for "absent on that side". */
export interface ScopeDriftItem {
  readonly code: ScopeDriftCode;
  /** The field, path, package name, projection id or property that differs. */
  readonly subject: string;
  readonly selected: JsonValue;
  readonly recomputed: JsonValue;
}

export type ScopeDriftAssessment =
  | { readonly status: 'no_drift'; readonly snapshot_sha256: Sha256Hex }
  | {
      readonly status: 'drift';
      readonly selected_sha256: Sha256Hex;
      readonly recomputed_sha256: Sha256Hex;
      readonly items: readonly ScopeDriftItem[];
      /** One rejection reason per item, ready for the admission rejection. */
      readonly reasons: readonly StructuredReason[];
    };

/**
 * Compares the selected probe's snapshot with the snapshot recomputed at admission.
 *
 * @example
 * const drift = compareScopeSnapshots(selectedSnapshot, recomputed);
 * if (drift.status === 'drift') reject('qualification', drift.reasons);
 */
export function compareScopeSnapshots(
  selected: TransportScopeSnapshot,
  recomputed: TransportScopeSnapshot,
): ScopeDriftAssessment {
  const selectedSha256 = scopeSnapshotSha256(selected);
  const recomputedSha256 = scopeSnapshotSha256(recomputed);
  if (selectedSha256 === recomputedSha256) {
    return { status: 'no_drift', snapshot_sha256: selectedSha256 };
  }
  const fieldItems = itemizeDrift(selected, recomputed);
  const items =
    fieldItems.length > 0
      ? fieldItems
      : [driftItem('SCOPE_SNAPSHOT_CHANGED', 'transport_scope_snapshot', selectedSha256, recomputedSha256)];
  return {
    status: 'drift',
    selected_sha256: selectedSha256,
    recomputed_sha256: recomputedSha256,
    items,
    reasons: items.map(driftReason),
  };
}

function itemizeDrift(selected: TransportScopeSnapshot, recomputed: TransportScopeSnapshot): readonly ScopeDriftItem[] {
  return [
    ...diffValue('SCOPE_POLICY_CHANGED', 'policy_sha256', selected.policy_sha256, recomputed.policy_sha256),
    ...diffValue('SCOPE_ENTRY_POINTS_CHANGED', 'entry_points', selected.entry_points, recomputed.entry_points),
    ...diffKeyed(
      'SCOPED_SOURCE_CHANGED',
      keyedBy(selected.source_files, (file) => [file.path, file.sha256]),
      keyedBy(recomputed.source_files, (file) => [file.path, file.sha256]),
    ),
    ...diffKeyed('SCOPED_DEPENDENCY_CHANGED', versionsByName(selected), versionsByName(recomputed)),
    ...diffValue('SCOPED_LOCKFILE_CHANGED', 'lockfile_sha256', selected.lockfile_sha256, recomputed.lockfile_sha256),
    ...diffKeyed(
      'SCOPED_CONFIGURATION_CHANGED',
      keyedBy(selected.configuration_projections, (p) => [p.projection_id, p.resources.map(projectedResourceJson)]),
      keyedBy(recomputed.configuration_projections, (p) => [p.projection_id, p.resources.map(projectedResourceJson)]),
    ),
    ...diffKeyed(
      'SCOPED_RUNTIME_PROPERTY_CHANGED',
      new Map(Object.entries(selected.runtime_properties)),
      new Map(Object.entries(recomputed.runtime_properties)),
    ),
    ...diffKeyed('SCOPED_TIMING_CHANGED', timingByName(selected.timing_values), timingByName(recomputed.timing_values)),
    ...diffValue(
      'SCOPED_WARMUP_POLICY_CHANGED',
      'provider_warmup',
      { invocations_per_trial: selected.provider_warmup.invocations_per_trial },
      { invocations_per_trial: recomputed.provider_warmup.invocations_per_trial },
    ),
  ];
}

function diffValue(
  code: ScopeDriftCode,
  subject: string,
  selected: JsonValue,
  recomputed: JsonValue,
): readonly ScopeDriftItem[] {
  return canonicalJson(selected) === canonicalJson(recomputed) ? [] : [driftItem(code, subject, selected, recomputed)];
}

function diffKeyed(
  code: ScopeDriftCode,
  selected: ReadonlyMap<string, JsonValue>,
  recomputed: ReadonlyMap<string, JsonValue>,
): readonly ScopeDriftItem[] {
  const keys = sortedCodeUnits(new Set([...selected.keys(), ...recomputed.keys()]));
  return keys.flatMap((key) => diffValue(code, key, selected.get(key) ?? null, recomputed.get(key) ?? null));
}

function keyedBy<T>(
  items: readonly T[],
  entry: (item: T) => readonly [string, JsonValue],
): ReadonlyMap<string, JsonValue> {
  return new Map(items.map(entry));
}

function versionsByName(snapshot: TransportScopeSnapshot): ReadonlyMap<string, JsonValue> {
  const versions = new Map<string, string[]>();
  for (const dependency of snapshot.dependency_closure) {
    versions.set(dependency.name, [...(versions.get(dependency.name) ?? []), dependency.version]);
  }
  return new Map([...versions].map(([name, list]) => [name, sortedCodeUnits(list)]));
}

function timingByName(timing: ScopeTimingValues): ReadonlyMap<string, JsonValue> {
  return new Map(SCOPE_TIMING_KEYS.map((name) => [name, timing[name]]));
}

function driftItem(code: ScopeDriftCode, subject: string, selected: JsonValue, recomputed: JsonValue): ScopeDriftItem {
  return { code, subject, selected, recomputed };
}

function driftReason(item: ScopeDriftItem): StructuredReason {
  return {
    code: item.code,
    subject: SCOPE_REASON_SUBJECT,
    detail:
      `${item.subject}: selected probe scope has ${canonicalJson(item.selected)}, current committed source has ` +
      `${canonicalJson(item.recomputed)}; expected identical scope, otherwise a new transport probe is required`,
  };
}
