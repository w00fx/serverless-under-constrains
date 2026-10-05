// Recomputation of the transport scope from committed source (BR-RUA-028): a probe's
// admission creates the snapshot it will qualify, and a run's or validation's admission
// recomputes it and compares it with the selected probe's (AC-RUA-051). Reads go through two
// read-only ports, so the same sequence runs over git and esbuild in production and over
// named fakes in tests.

import { sha256Hex } from '../../record-contract/digests.ts';
import type { Result, Sha256Hex, StructuredReason } from '../../record-contract/primitives.ts';
import type {
  ProviderWarmupPolicy,
  ScopeTimingValues,
  TransportScopeSnapshot,
} from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import type { RecordValidator } from '../../record-contract/schema-registry.ts';
import { isPackageRelativePath } from '../../record-contract/schema-vocabulary.ts';
import type { BundleInputResolver, BundleInputs } from './bundle-inputs.ts';
import type { CfnTemplate } from './cfn-template.ts';
import { PACKAGE_LOCK_PATH, parsePackageLock } from './package-lock.ts';
import { TRANSPORT_SCOPE_POLICY_PATH, parseTransportScopePolicy } from './scope-policy.ts';
import { scopeViolation } from './scope-reasons.ts';
import type { RuntimePropertyValue } from './scope-snapshot.ts';
import { computeScopeSnapshot } from './scope-snapshot.ts';

/** Committed source of the project at the admitted revision; paths are project-relative. */
export interface CommittedSourceReader {
  /** Every committed file under the given roots, sorted. */
  listFiles(roots: readonly string[]): Promise<readonly string[]>;
  /** The committed bytes of a file, or `undefined` when the revision does not contain it. */
  read(path: string): Promise<Uint8Array | undefined>;
}

export interface ScopeRecomputationPorts {
  readonly sources: CommittedSourceReader;
  readonly bundles: BundleInputResolver;
  readonly validator: RecordValidator;
}

/** Values the snapshot binds that do not come from source files. */
export interface ScopeEnvironment {
  /** The synthesized template of the execution being admitted. */
  readonly template: CfnTemplate;
  readonly runtime: Readonly<Record<string, RuntimePropertyValue>>;
  readonly timing: ScopeTimingValues;
  readonly provider_warmup: ProviderWarmupPolicy;
}

/**
 * Reads the committed policy and lockfile, resolves every entry point's bundle closure,
 * digests every scoped file and computes the snapshot.
 *
 * @example
 * const recomputed = await recomputeScopeSnapshot(environment, { sources, bundles, validator });
 * if (recomputed.ok) compareScopeSnapshots(selectedSnapshot, recomputed.value);
 */
export async function recomputeScopeSnapshot(
  environment: ScopeEnvironment,
  ports: ScopeRecomputationPorts,
): Promise<Result<TransportScopeSnapshot, readonly StructuredReason[]>> {
  const policyBytes = await ports.sources.read(TRANSPORT_SCOPE_POLICY_PATH);
  if (policyBytes === undefined) {
    return notCommitted('SCOPE_POLICY_UNREADABLE', TRANSPORT_SCOPE_POLICY_PATH);
  }
  const policy = parseTransportScopePolicy(policyBytes, ports.validator);
  if (!policy.ok) {
    return policy;
  }
  const lockBytes = await ports.sources.read(PACKAGE_LOCK_PATH);
  if (lockBytes === undefined) {
    return notCommitted('LOCKFILE_UNREADABLE', PACKAGE_LOCK_PATH);
  }
  const lock = parsePackageLock(lockBytes);
  if (!lock.ok) {
    return { ok: false, error: [lock.error] };
  }
  const bundles = await resolveBundles(ports.bundles, policy.value.policy.entry_points);
  if (!bundles.ok) {
    return { ok: false, error: [bundles.error] };
  }
  const committedFiles = await ports.sources.listFiles(policy.value.policy.source_roots);
  const scopedPaths = new Set([...committedFiles, ...bundles.value.flatMap((bundle) => bundle.local_sources)]);
  return computeScopeSnapshot({
    policy: policy.value,
    bundles: bundles.value,
    committed_files: committedFiles,
    source_digests: await committedDigests(ports.sources, scopedPaths),
    lock: lock.value,
    template: environment.template,
    runtime: environment.runtime,
    timing: environment.timing,
    provider_warmup: environment.provider_warmup,
  });
}

async function resolveBundles(
  resolver: BundleInputResolver,
  entryPoints: readonly string[],
): Promise<Result<readonly BundleInputs[], StructuredReason>> {
  try {
    return { ok: true, value: await resolver.resolve(entryPoints) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: scopeViolation(
        'BUNDLE_RESOLUTION_FAILED',
        `bundling ${JSON.stringify(entryPoints)} failed: ${message}; expected every entry point and import to resolve`,
      ),
    };
  }
}

// Paths outside the project are never read; computeScopeSnapshot reports them.
async function committedDigests(
  sources: CommittedSourceReader,
  paths: ReadonlySet<string>,
): Promise<ReadonlyMap<string, Sha256Hex>> {
  const digests = new Map<string, Sha256Hex>();
  for (const path of [...paths].filter(isPackageRelativePath)) {
    const bytes = await sources.read(path);
    if (bytes !== undefined) {
      digests.set(path, sha256Hex(bytes));
    }
  }
  return digests;
}

function notCommitted(
  code: 'SCOPE_POLICY_UNREADABLE' | 'LOCKFILE_UNREADABLE',
  path: string,
): Result<never, readonly StructuredReason[]> {
  return {
    ok: false,
    error: [scopeViolation(code, `${path} is not committed at the admitted revision; expected a committed file`)],
  };
}
