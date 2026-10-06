// `transport_scope_snapshot` (BR-RUA-028): the frozen, recomputable qualification scope. It
// carries no execution identity and no timestamp, so a recomputation over unchanged committed
// source is byte-identical and any drift is a structural difference.

import type { Sha256Hex } from '../../primitives.ts';

export interface ScopedSourceFile {
  readonly path: string;
  readonly sha256: Sha256Hex;
}

export interface ResolvedDependency {
  readonly name: string;
  readonly version: string;
}

/**
 * One policy property path of one selected resource. The value is the canonical JSON text of
 * the normalized CloudFormation value (names, ARNs, ids and tags stripped): CloudFormation
 * member names such as `StreamViewType` or `Fn::GetAtt` are not BR-RUA-033 property names, so
 * the snapshot carries them as text. `canonical_json` is omitted when the resource does not set
 * the property, because an absent property is configuration too.
 */
export interface ProjectedProperty {
  readonly property_path: string;
  readonly canonical_json?: string;
}

/** The projected properties of one selected resource, in policy order. */
export interface ProjectedResource {
  readonly property_values: readonly [ProjectedProperty, ...ProjectedProperty[]];
}

export interface NormalizedConfigurationProjection {
  readonly projection_id: string;
  /** One entry per selected resource, in canonical order; equal resources give equal entries. */
  readonly resources: readonly [ProjectedResource, ...ProjectedResource[]];
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
  /**
   * SHA-256 of the canonical JSON of the closure's lockfile entries, keyed by install path, each
   * with its version and, when recorded, resolved and integrity; not of the package-lock.json
   * bytes (the schema description states the exact input).
   */
  readonly lockfile_sha256: Sha256Hex;
  readonly configuration_projections: readonly [
    NormalizedConfigurationProjection,
    ...NormalizedConfigurationProjection[],
  ];
  /**
   * The runtime property values the committed policy names. The policy, not this schema, owns
   * the names and their meaning, so each value is a string, safe integer or boolean and the
   * snapshot builder checks it against the policy.
   */
  readonly runtime_properties: Readonly<Record<string, string | number | boolean>>;
  readonly timing_values: ScopeTimingValues;
  readonly provider_warmup: ProviderWarmupPolicy;
}
