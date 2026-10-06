// The frozen transport-scope snapshot (BR-RUA-028): what one transport probe actually
// exercised. It holds the policy digest, the resolved entry points, every scoped source file
// with its exact committed digest, the production dependency closure with resolved versions,
// the normalized provider and controller configuration, the runtime properties, the timing
// values and the provider warm-up policy (addendum §2).
//
// The snapshot carries no execution identity and no timestamp, and every collection is in
// canonical order, so recomputing it over unchanged committed source yields identical bytes.
//
// Scoped sources are the union of the bundler's transitive closure of every entry point and
// every committed file under a conservative source root. A file outside both, such as an
// oracle, reporting or orchestration module, never enters the snapshot.

import { serializeRecordFile } from '../../record-contract/canonical-json.ts';
import { sha256Hex } from '../../record-contract/digests.ts';
import type { Result, Sha256Hex, StructuredReason } from '../../record-contract/primitives.ts';
import type {
  NormalizedConfigurationProjection,
  ProviderWarmupPolicy,
  ScopeTimingValues,
  ScopedSourceFile,
  TransportScopeSnapshot,
} from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import type { TransportScopePolicy } from '../../record-contract/records/group-a/transport_scope_policy.ts';
import { isPackageRelativePath } from '../../record-contract/schema-vocabulary.ts';
import type { BundleInputs } from './bundle-inputs.ts';
import { compareCodeUnits, sortedCodeUnits } from './bundle-inputs.ts';
import type { CfnTemplate } from './cfn-template.ts';
import { listTemplateResources } from './cfn-template.ts';
import { normalizeConfigurationProjection } from './configuration-projection.ts';
import { resolveDependencyClosure } from './dependency-closure.ts';
import type { PackageLock } from './package-lock.ts';
import type { LoadedScopePolicy } from './scope-policy.ts';
import { scopeViolation } from './scope-reasons.ts';

export type RuntimePropertyValue = string | number | boolean;

export interface ScopeSnapshotInput {
  readonly policy: LoadedScopePolicy;
  /** The bundler's closure of each policy entry point. */
  readonly bundles: readonly BundleInputs[];
  /** Committed files under the policy source roots (other paths are ignored). */
  readonly committed_files: readonly string[];
  /** SHA-256 of the committed bytes of each scoped path; a path absent here is not committed. */
  readonly source_digests: ReadonlyMap<string, Sha256Hex>;
  readonly lock: PackageLock;
  readonly template: CfnTemplate;
  /** Runtime property values; only the names the policy declares enter the snapshot. */
  readonly runtime: Readonly<Record<string, RuntimePropertyValue>>;
  readonly timing: ScopeTimingValues;
  readonly provider_warmup: ProviderWarmupPolicy;
}

type NonEmpty<T> = readonly [T, ...T[]];

/** The timing values a snapshot binds, in declaration order. */
export const SCOPE_TIMING_KEYS = [
  'provider_client_deadline_ms',
  'provider_safety_release_ms',
  'provider_execution_timeout_ms',
  'treatment_poll_interval_ms',
] as const satisfies readonly (keyof ScopeTimingValues)[];

/**
 * Computes the snapshot, or every reason it cannot be computed.
 *
 * @example
 * const snapshot = computeScopeSnapshot({ policy, bundles, committed_files, source_digests, lock, template,
 *   runtime, timing, provider_warmup: { invocations_per_trial: 1 } });
 * if (snapshot.ok) writeOnce('admission/transport-scope-snapshot.json', serializeRecordFile(snapshot.value));
 */
export function computeScopeSnapshot(
  input: ScopeSnapshotInput,
): Result<TransportScopeSnapshot, readonly StructuredReason[]> {
  const policy = input.policy.policy;
  const bundles = entryPointBundles(policy, input.bundles);
  const sources = scopedSourceFiles(policy, bundles.value, input);
  const closure = resolveDependencyClosure({
    bundled_packages: bundles.value.flatMap((bundle) => bundle.packages),
    declared_dependencies: policy.dependencies,
    lock: input.lock,
  });
  const projections = configurationProjections(policy, input.template);
  const runtime = runtimeProperties(policy, input.runtime);
  const timingReasons = timingViolations(input.timing);
  const reasons = [
    ...bundles.reasons,
    ...sources.reasons,
    ...(closure.ok ? [] : closure.error),
    ...projections.reasons,
    ...runtime.reasons,
    ...timingReasons,
  ];
  if (!closure.ok || reasons.length > 0) {
    return { ok: false, error: reasons };
  }
  // Each collection below is non-empty here: the policy schema requires at least one entry
  // point, source root, projection and dependency, every source root contributed a file,
  // every declared dependency resolved and every projection selected a resource.
  return {
    ok: true,
    value: {
      schema_version: 1,
      record_type: 'transport_scope_snapshot',
      policy_sha256: input.policy.policy_sha256,
      entry_points: sortedCodeUnits(policy.entry_points) as NonEmpty<string>,
      source_files: sources.value as NonEmpty<ScopedSourceFile>,
      dependency_closure: closure.value.dependencies as TransportScopeSnapshot['dependency_closure'],
      lockfile_sha256: closure.value.lockfile_sha256,
      configuration_projections: projections.value as NonEmpty<NormalizedConfigurationProjection>,
      runtime_properties: runtime.value,
      timing_values: {
        provider_client_deadline_ms: input.timing.provider_client_deadline_ms,
        provider_safety_release_ms: input.timing.provider_safety_release_ms,
        provider_execution_timeout_ms: input.timing.provider_execution_timeout_ms,
        treatment_poll_interval_ms: input.timing.treatment_poll_interval_ms,
      },
      provider_warmup: { invocations_per_trial: input.provider_warmup.invocations_per_trial },
    },
  };
}

/**
 * The digest a manifest and a qualification selection record for a snapshot: SHA-256 of
 * its canonical record file bytes.
 *
 * @example
 * manifest.transport_scope_snapshot_sha256 = scopeSnapshotSha256(snapshot);
 */
export function scopeSnapshotSha256(snapshot: TransportScopeSnapshot): Sha256Hex {
  return sha256Hex(serializeRecordFile(snapshot));
}

/**
 * Tells whether a path is a source root itself or lies below it.
 *
 * @example
 * isUnderSourceRoot('src/provider-client/arbiter.ts', 'src/provider-client'); // true
 * isUnderSourceRoot('src/provider-client-extra/x.ts', 'src/provider-client'); // false
 */
export function isUnderSourceRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

interface Collected<T> {
  readonly value: T;
  readonly reasons: readonly StructuredReason[];
}

function entryPointBundles(
  policy: TransportScopePolicy,
  bundles: readonly BundleInputs[],
): Collected<readonly BundleInputs[]> {
  const matched: BundleInputs[] = [];
  const reasons: StructuredReason[] = [];
  for (const entryPoint of policy.entry_points) {
    const found = bundles.filter((bundle) => bundle.entry_point === entryPoint);
    if (found.length === 1) {
      matched.push(...found);
      continue;
    }
    reasons.push(
      scopeViolation(
        'BUNDLE_MISSING_ENTRY_POINT',
        `entry point ${entryPoint} has ${String(found.length)} resolved bundles; expected exactly one`,
      ),
    );
  }
  return { value: matched, reasons };
}

function scopedSourceFiles(
  policy: TransportScopePolicy,
  bundles: readonly BundleInputs[],
  input: ScopeSnapshotInput,
): Collected<readonly ScopedSourceFile[]> {
  const reasons: StructuredReason[] = [];
  const closure = new Set(bundles.flatMap((bundle) => bundle.local_sources));
  for (const path of closure) {
    if (!isPackageRelativePath(path)) {
      reasons.push(
        scopeViolation(
          'BUNDLE_INPUT_OUTSIDE_PROJECT',
          `bundled input ${JSON.stringify(path)}; expected a normalized path inside the project`,
        ),
      );
    }
  }
  const rooted = new Set<string>();
  for (const root of policy.source_roots) {
    const files = input.committed_files.filter((path) => isUnderSourceRoot(path, root));
    if (files.length === 0) {
      reasons.push(
        scopeViolation('SOURCE_ROOT_EMPTY', `source root ${root} holds no committed file; expected at least one`),
      );
    }
    files.forEach((path) => rooted.add(path));
  }
  const files: ScopedSourceFile[] = [];
  for (const path of sortedCodeUnits(new Set([...closure, ...rooted])).filter(isPackageRelativePath)) {
    const sha256 = input.source_digests.get(path);
    if (sha256 === undefined) {
      reasons.push(
        scopeViolation(
          'SCOPED_SOURCE_NOT_COMMITTED',
          `scoped source ${path} has no committed content; expected a committed file`,
        ),
      );
      continue;
    }
    files.push({ path, sha256 });
  }
  return { value: files, reasons };
}

function configurationProjections(
  policy: TransportScopePolicy,
  template: CfnTemplate,
): Collected<readonly NormalizedConfigurationProjection[]> {
  const resources = listTemplateResources(template);
  if (!resources.ok) {
    return { value: [], reasons: [resources.error] };
  }
  const projections: NormalizedConfigurationProjection[] = [];
  const reasons: StructuredReason[] = [];
  for (const projection of policy.configuration_projections) {
    const resources = normalizeConfigurationProjection(template, projection);
    if (resources.ok) {
      projections.push({ projection_id: projection.projection_id, resources: resources.value });
    } else {
      reasons.push(resources.error);
    }
  }
  projections.sort((a, b) => compareCodeUnits(a.projection_id, b.projection_id));
  return { value: projections, reasons };
}

function runtimeProperties(
  policy: TransportScopePolicy,
  provided: Readonly<Record<string, RuntimePropertyValue>>,
): Collected<Readonly<Record<string, RuntimePropertyValue>>> {
  const values: Record<string, RuntimePropertyValue> = {};
  const reasons: StructuredReason[] = [];
  for (const name of policy.runtime_properties) {
    const value = Object.hasOwn(provided, name) ? provided[name] : undefined;
    if (value === undefined) {
      reasons.push(
        scopeViolation(
          'RUNTIME_PROPERTY_MISSING',
          `runtime property ${name} is absent; expected a string, integer or boolean`,
        ),
      );
      continue;
    }
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      reasons.push(
        scopeViolation(
          'RUNTIME_PROPERTY_INVALID',
          `runtime property ${name} is ${String(value)}; expected a safe integer`,
        ),
      );
      continue;
    }
    values[name] = value;
  }
  return { value: values, reasons };
}

function timingViolations(timing: ScopeTimingValues): readonly StructuredReason[] {
  return SCOPE_TIMING_KEYS.filter((name) => !Number.isSafeInteger(timing[name]) || timing[name] < 1).map((name) =>
    scopeViolation(
      'TIMING_VALUE_INVALID',
      `timing value ${name} is ${String(timing[name])}; expected a positive safe integer of milliseconds`,
    ),
  );
}
