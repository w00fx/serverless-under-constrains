// The transitive production dependency closure of the transport scope (BR-RUA-028): every
// package the bundler pulled into a transport entry point, plus every dependency the policy
// declares relevant, each resolved to its exact locked version.
//
// The probe qualifies only the code it actually exercised (BR-RUA-028), and the bundler reads
// packages from `node_modules`, not from the lockfile. Every closure package must therefore be
// installed at its locked version: a stale install (lockfile 1.1.0, `node_modules` still 1.0.0)
// would otherwise bind 1.1.0 to a probe that ran 1.0.0, and a later run on 1.1.0 would pass as
// no drift (WP-11 review round 1, verify/spec-r1-stale-install.log).
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
  /** The installed `package.json` version of each closure install path; an absent path is not installed. */
  readonly installed_versions: ReadonlyMap<string, string>;
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
 * The install paths of the closure: every bundled package and every declared dependency, sorted
 * and unique.
 *
 * @example
 * closureInstallPaths(['node_modules/@smithy/types'], ['esbuild']); // ['node_modules/@smithy/types', 'node_modules/esbuild']
 */
export function closureInstallPaths(bundled: readonly string[], declared: readonly string[]): readonly string[] {
  return sortedCodeUnits(new Set([...bundled, ...declared.map((name) => `node_modules/${name}`)]));
}

/**
 * Resolves the closure against the lockfile, reporting every unlocked, development-only or
 * not-as-locked installed package.
 *
 * @example
 * resolveDependencyClosure({ bundled_packages: ['node_modules/@smithy/types'], declared_dependencies: ['esbuild'], lock,
 *   installed_versions: new Map([['node_modules/@smithy/types', '4.3.1'], ['node_modules/esbuild', '0.28.2']]) });
 */
export function resolveDependencyClosure(
  input: DependencyClosureInput,
): Result<DependencyClosure, readonly StructuredReason[]> {
  const reasons: StructuredReason[] = [];
  const resolved: LockedVersionedPackage[] = [];
  const bundled = new Set(input.bundled_packages);
  for (const installPath of closureInstallPaths(input.bundled_packages, input.declared_dependencies)) {
    const locked = lockedVersion(input.lock, installPath);
    if (!locked.ok) {
      reasons.push(locked.error);
      continue;
    }
    const installed = input.installed_versions.get(installPath);
    if (installed !== locked.value.version) {
      reasons.push(installMismatch(installPath, installed, locked.value.version));
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

function installMismatch(installPath: string, installed: string | undefined, locked: string): StructuredReason {
  const found = installed === undefined ? 'not installed' : `installed at ${installed}`;
  return scopeViolation(
    'DEPENDENCY_INSTALL_MISMATCH',
    `${installPath} is ${found} but ${PACKAGE_LOCK_PATH} locks ${locked}; expected the locked version installed ` +
      '(npm ci at the admitted revision)',
  );
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
