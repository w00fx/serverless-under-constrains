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
import type { BundleInputResolver } from './bundle-inputs.ts';
import type { CfnTemplate } from './cfn-template.ts';
import { PACKAGE_LOCK_PATH, parsePackageLock } from './package-lock.ts';
import { TRANSPORT_SCOPE_POLICY_PATH, parseTransportScopePolicy } from './scope-policy.ts';
import { scopeViolation } from './scope-reasons.ts';
import type { RuntimePropertyValue } from './scope-snapshot.ts';
import { computeScopeSnapshot } from './scope-snapshot.ts';

/**
 * Committed source of the project at the admitted revision; paths are project-relative. Both
 * methods reject on an operational failure (the revision or repository cannot be read), which
 * is never the same as "not committed".
 */
export interface CommittedSourceReader {
  /** Every committed file under the given roots, sorted; no root lists no file. */
  listFiles(roots: readonly string[]): Promise<readonly string[]>;
  /** The committed bytes of a file, or `undefined` when the revision has no file at that path. */
  read(path: string): Promise<Uint8Array | undefined>;
}

export interface ScopeRecomputationPorts {
  readonly sources: CommittedSourceReader;
  readonly bundles: BundleInputResolver;
  readonly validator: RecordValidator;
}

/** Values the snapshot binds that do not come from source files. */
export interface ScopeEnvironment {
  /**
   * The synthesized template of the execution being admitted. It must carry the
   * `aws:cdk:path` resource metadata: `cdk synth` emits it by default, and a programmatic
   * synthesis needs the context `CDK_PATH_METADATA_CONTEXT_KEY` set to true. Without it every
   * projection reports TEMPLATE_WITHOUT_PATH_METADATA.
   */
  readonly template: CfnTemplate;
  /**
   * Runtime property values. The bundler's own `runtime_properties` are added to them; a value
   * here that contradicts the bundler's is RUNTIME_PROPERTY_INVALID.
   */
  readonly runtime: Readonly<Record<string, RuntimePropertyValue>>;
  readonly timing: ScopeTimingValues;
  readonly provider_warmup: ProviderWarmupPolicy;
}

type Recomputed = Result<TransportScopeSnapshot, readonly StructuredReason[]>;

/**
 * Reads the committed policy and lockfile, resolves every entry point's bundle closure,
 * digests every scoped file and computes the snapshot. Total: a port failure is a structured
 * reason (SOURCE_READ_FAILED, BUNDLE_RESOLUTION_FAILED), never a rejected promise.
 *
 * @example
 * const recomputed = await recomputeScopeSnapshot(environment, { sources, bundles, validator });
 * if (recomputed.ok) compareScopeSnapshots(selectedSnapshot, recomputed.value);
 */
export async function recomputeScopeSnapshot(
  environment: ScopeEnvironment,
  ports: ScopeRecomputationPorts,
): Promise<Recomputed> {
  const policyBytes = await readCommitted(ports.sources, TRANSPORT_SCOPE_POLICY_PATH, 'SCOPE_POLICY_UNREADABLE');
  if (!policyBytes.ok) {
    return policyBytes;
  }
  const policy = parseTransportScopePolicy(policyBytes.value, ports.validator);
  if (!policy.ok) {
    return policy;
  }
  const lockBytes = await readCommitted(ports.sources, PACKAGE_LOCK_PATH, 'LOCKFILE_UNREADABLE');
  if (!lockBytes.ok) {
    return lockBytes;
  }
  const lock = parsePackageLock(lockBytes.value);
  if (!lock.ok) {
    return { ok: false, error: [lock.error] };
  }
  const runtime = bundlerRuntime(environment.runtime, ports.bundles.runtime_properties);
  if (!runtime.ok) {
    return runtime;
  }
  const entryPoints = policy.value.policy.entry_points;
  const bundles = await attempt(
    () => ports.bundles.resolve(entryPoints),
    'BUNDLE_RESOLUTION_FAILED',
    `bundling ${JSON.stringify(entryPoints)}`,
    'expected every entry point and import to resolve',
  );
  if (!bundles.ok) {
    return bundles;
  }
  const roots = policy.value.policy.source_roots;
  const committedFiles = await attempt(
    () => ports.sources.listFiles(roots),
    'SOURCE_READ_FAILED',
    `listing the committed files under ${JSON.stringify(roots)}`,
    'expected the admitted revision to be readable',
  );
  if (!committedFiles.ok) {
    return committedFiles;
  }
  const scopedPaths = new Set([...committedFiles.value, ...bundles.value.flatMap((bundle) => bundle.local_sources)]);
  const digests = await committedDigests(ports.sources, scopedPaths);
  if (!digests.ok) {
    return digests;
  }
  return computeScopeSnapshot({
    policy: policy.value,
    bundles: bundles.value,
    committed_files: committedFiles.value,
    source_digests: digests.value,
    lock: lock.value,
    template: environment.template,
    runtime: runtime.value,
    timing: environment.timing,
    provider_warmup: environment.provider_warmup,
  });
}

/**
 * Runs one port call and turns a rejection into a structured reason naming the operation and
 * the thrown message.
 */
async function attempt<T>(
  operation: () => Promise<T>,
  code: 'BUNDLE_RESOLUTION_FAILED' | 'SOURCE_READ_FAILED',
  action: string,
  expected: string,
): Promise<Result<T, readonly StructuredReason[]>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: [scopeViolation(code, `${action} failed: ${message}; ${expected}`)] };
  }
}

async function readCommitted(
  sources: CommittedSourceReader,
  path: string,
  absentCode: 'SCOPE_POLICY_UNREADABLE' | 'LOCKFILE_UNREADABLE',
): Promise<Result<Uint8Array, readonly StructuredReason[]>> {
  const bytes = await readSource(sources, path);
  if (!bytes.ok) {
    return bytes;
  }
  if (bytes.value !== undefined) {
    return { ok: true, value: bytes.value };
  }
  return {
    ok: false,
    error: [scopeViolation(absentCode, `${path} is not committed at the admitted revision; expected a committed file`)],
  };
}

function readSource(
  sources: CommittedSourceReader,
  path: string,
): Promise<Result<Uint8Array | undefined, readonly StructuredReason[]>> {
  return attempt(
    () => sources.read(path),
    'SOURCE_READ_FAILED',
    `reading committed ${path}`,
    'expected the admitted revision to be readable',
  );
}

// Paths outside the project are never read; computeScopeSnapshot reports them. A path the
// revision does not contain gets no digest, which computeScopeSnapshot reports as not committed.
async function committedDigests(
  sources: CommittedSourceReader,
  paths: ReadonlySet<string>,
): Promise<Result<ReadonlyMap<string, Sha256Hex>, readonly StructuredReason[]>> {
  const digests = new Map<string, Sha256Hex>();
  for (const path of [...paths].filter(isPackageRelativePath)) {
    const bytes = await readSource(sources, path);
    if (!bytes.ok) {
      return bytes;
    }
    if (bytes.value !== undefined) {
      digests.set(path, sha256Hex(bytes.value));
    }
  }
  return { ok: true, value: digests };
}

// The bundler's options are what produced the closure, so they are the values bound; the
// environment may restate them but never contradict them.
function bundlerRuntime(
  environment: Readonly<Record<string, RuntimePropertyValue>>,
  bundler: Readonly<Record<string, RuntimePropertyValue>>,
): Result<Readonly<Record<string, RuntimePropertyValue>>, readonly StructuredReason[]> {
  const conflicts = Object.entries(bundler)
    .filter(([name, value]) => Object.hasOwn(environment, name) && environment[name] !== value)
    .map(([name, value]) =>
      scopeViolation(
        'RUNTIME_PROPERTY_INVALID',
        `runtime property ${name} is ${JSON.stringify(environment[name])} in the admission environment but the bundler ` +
          `resolved with ${JSON.stringify(value)}; expected the bundler's value`,
      ),
    );
  return conflicts.length > 0 ? { ok: false, error: conflicts } : { ok: true, value: { ...environment, ...bundler } };
}
