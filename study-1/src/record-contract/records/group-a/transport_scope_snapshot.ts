// `transport_scope_snapshot` (BR-RUA-028): the frozen, recomputable qualification scope. It
// carries no execution identity and no timestamp, so a recomputation over unchanged committed
// source is byte-identical and any drift is a structural difference.

import type { JsonValue, Sha256Hex } from '../../primitives.ts';

export interface ScopedSourceFile {
  readonly path: string;
  readonly sha256: Sha256Hex;
}

export interface ResolvedDependency {
  readonly name: string;
  readonly version: string;
}

export interface NormalizedConfigurationProjection {
  readonly projection_id: string;
  /** Configuration values with names, ARNs, ids and tags stripped. */
  readonly values: JsonValue;
}

/** The transport timing values in force when the snapshot was taken (OR-RUA-002). */
export interface ScopeTimingValues {
  readonly provider_client_deadline_ms: number;
  readonly provider_safety_release_ms: number;
  readonly provider_execution_timeout_ms: number;
  readonly treatment_poll_interval_ms: number;
}

/** Addendum §2: the provider is warmed exactly once before each trial's publication. */
export interface ProviderWarmupPolicy {
  readonly invocations_per_trial: 1;
}

export interface TransportScopeSnapshot {
  readonly schema_version: 1;
  readonly record_type: 'transport_scope_snapshot';
  readonly policy_sha256: Sha256Hex;
  readonly entry_points: readonly [string, ...string[]];
  readonly source_files: readonly [ScopedSourceFile, ...ScopedSourceFile[]];
  readonly dependency_closure: readonly [ResolvedDependency, ...ResolvedDependency[]];
  readonly lockfile_sha256: Sha256Hex;
  readonly configuration_projections: readonly [
    NormalizedConfigurationProjection,
    ...NormalizedConfigurationProjection[],
  ];
  readonly runtime_properties: Readonly<Record<string, string | number | boolean>>;
  readonly timing_values: ScopeTimingValues;
  readonly provider_warmup: ProviderWarmupPolicy;
}
