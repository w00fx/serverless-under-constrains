// The transitive production dependency closure of the transport scope (BR-RUA-028): every
// package the bundler pulled into a transport entry point, plus every dependency the policy
// declares relevant, each resolved to its exact locked version.
//
// The lockfile digest binds only the closure's own lockfile entries (version, tarball URL and
// integrity). A dependency change elsewhere in the lockfile, such as a reporting-only package,
// therefore never drifts the scope, while a re-published tarball under the same version does.

import { canonicalJson } from '../../record-contract/canonical-json.ts';
import { sha256Hex } from '../../record-contract/digests.ts';
import type { JsonObject, Result, Sha256Hex, StructuredReason } from '../../record-contract/primitives.ts';
import type { ResolvedDependency } from '../../record-contract/records/group-a/transport_scope_snapshot.ts';
import { compareCodeUnits, sortedCodeUnits } from './bundle-inputs.ts';
import type { LockedPackage, PackageLock } from './package-lock.ts';
import { PACKAGE_LOCK_PATH } from './package-lock.ts';
import { scopeViolation } from './scope-reasons.ts';

export interface DependencyClosureInput {
  /** Install paths of every bundled package. */
  readonly bundled_packages: readonly string[];
  /** Package names the policy declares relevant; each resolves at `node_modules/<name>`. */
  readonly declared_dependencies: readonly string[];
  readonly lock: PackageLock;
}

export interface DependencyClosure {
  /** Unique `{name, version}` pairs sorted by name, then version. */
  readonly dependencies: readonly ResolvedDependency[];
  /** SHA-256 of the canonical lockfile projection restricted to the closure's install paths. */
  readonly lockfile_sha256: Sha256Hex;
}

type LockedVersionedPackage = LockedPackage & { readonly version: string };

const encoder = new TextEncoder();

/**
 * Resolves the closure against the lockfile, reporting every unlocked or development-only
 * bundled package.
 *
 * @example
 * resolveDependencyClosure({ bundled_packages: ['node_modules/@smithy/types'], declared_dependencies: ['esbuild'], lock });
 */
export function resolveDependencyClosure(
  input: DependencyClosureInput,
): Result<DependencyClosure, readonly StructuredReason[]> {
  const reasons: StructuredReason[] = [];
  const resolved: LockedVersionedPackage[] = [];
  const declaredPaths = input.declared_dependencies.map((name) => `node_modules/${name}`);
  const bundled = new Set(input.bundled_packages);
  for (const installPath of sortedCodeUnits(new Set([...input.bundled_packages, ...declaredPaths]))) {
    const locked = lockedVersion(input.lock, installPath);
    if (!locked.ok) {
      reasons.push(locked.error);
      continue;
    }
    if (bundled.has(installPath) && locked.value.dev) {
      reasons.push(
        scopeViolation(
          'BUNDLED_PACKAGE_NOT_PRODUCTION',
          `bundled package ${installPath} is marked dev in ${PACKAGE_LOCK_PATH}; expected a production dependency`,
        ),
      );
    }
    resolved.push(locked.value);
  }
  if (reasons.length > 0) {
    return { ok: false, error: reasons };
  }
  return {
    ok: true,
    value: { dependencies: uniqueDependencies(resolved), lockfile_sha256: lockfileProjectionDigest(resolved) },
  };
}

function lockedVersion(lock: PackageLock, installPath: string): Result<LockedVersionedPackage, StructuredReason> {
  const locked = lock.packages.get(installPath);
  if (locked?.version === undefined) {
    const found = locked === undefined ? 'absent' : 'present without a version';
    return {
      ok: false,
      error: scopeViolation(
        'DEPENDENCY_NOT_LOCKED',
        `${installPath} is ${found} in ${PACKAGE_LOCK_PATH}; expected a locked entry with a version`,
      ),
    };
  }
  return { ok: true, value: { ...locked, version: locked.version } };
}

function uniqueDependencies(packages: readonly LockedVersionedPackage[]): readonly ResolvedDependency[] {
  const byKey = new Map<string, ResolvedDependency>();
  for (const locked of packages) {
    byKey.set(`${locked.name}@${locked.version}`, { name: locked.name, version: locked.version });
  }
  return [...byKey.values()].sort((a, b) => compareCodeUnits(a.name, b.name) || compareCodeUnits(a.version, b.version));
}

// The lockfile format version is left out: it changes no installed byte.
function lockfileProjectionDigest(packages: readonly LockedVersionedPackage[]): Sha256Hex {
  const entries: Record<string, JsonObject> = {};
  for (const locked of packages) {
    entries[locked.install_path] = {
      version: locked.version,
      ...(locked.resolved === undefined ? {} : { resolved: locked.resolved }),
      ...(locked.integrity === undefined ? {} : { integrity: locked.integrity }),
    };
  }
  return sha256Hex(encoder.encode(canonicalJson(entries)));
}
