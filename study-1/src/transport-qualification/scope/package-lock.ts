// A read model of `package-lock.json` (lockfile versions 2 and 3) that resolves package
// install paths to the exact versions and tarball identities the transport scope binds
// (BR-RUA-028 "resolved dependency versions"). The parser is total: malformed bytes give a
// structured reason, never an exception.

import { describeJson, isJsonObject } from '../../record-contract/json-value.ts';
import { parseJsonDocument } from '../../record-contract/parsing.ts';
import type { JsonObject, Result, StructuredReason } from '../../record-contract/primitives.ts';
import { scopeViolation } from './scope-reasons.ts';

export const PACKAGE_LOCK_PATH = 'package-lock.json';
const SUPPORTED_LOCKFILE_VERSIONS: readonly number[] = [2, 3];
const NODE_MODULES_SEGMENT = 'node_modules/';

/** One installed package as the lockfile records it. */
export interface LockedPackage {
  readonly install_path: string;
  /** The `name` field when the entry declares one (an alias), else the install directory name. */
  readonly name: string;
  readonly version?: string;
  readonly resolved?: string;
  readonly integrity?: string;
  /** True when npm marks the package as reachable only through development dependencies. */
  readonly dev: boolean;
}

export interface PackageLock {
  readonly lockfile_version: number;
  /** Keyed by install path, for example `node_modules/@smithy/types`; the root entry `""` is excluded. */
  readonly packages: ReadonlyMap<string, LockedPackage>;
}

/**
 * Parses lockfile bytes into installed packages keyed by install path.
 *
 * @example
 * const lock = parsePackageLock(readFileSync('package-lock.json'));
 * if (lock.ok) lock.value.packages.get('node_modules/esbuild')?.version; // '0.28.2'
 */
export function parsePackageLock(bytes: Uint8Array): Result<PackageLock, StructuredReason> {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    return { ok: false, error: invalidLockfile(`is not one JSON document (${parsed.error.kind})`) };
  }
  const document = parsed.value;
  if (!isJsonObject(document)) {
    return { ok: false, error: invalidLockfile(`is ${describeJson(document)}; expected a JSON object`) };
  }
  const version = document['lockfileVersion'];
  if (typeof version !== 'number' || !SUPPORTED_LOCKFILE_VERSIONS.includes(version)) {
    return { ok: false, error: invalidLockfile(`has lockfileVersion ${describeJson(version)}; expected 2 or 3`) };
  }
  const packages = document['packages'];
  if (!isJsonObject(packages)) {
    return { ok: false, error: invalidLockfile(`has packages ${describeJson(packages)}; expected a JSON object`) };
  }
  return { ok: true, value: { lockfile_version: version, packages: lockedPackages(packages) } };
}

function lockedPackages(packages: JsonObject): ReadonlyMap<string, LockedPackage> {
  const result = new Map<string, LockedPackage>();
  for (const [installPath, entry] of Object.entries(packages)) {
    if (installPath === '' || !isJsonObject(entry)) {
      continue;
    }
    result.set(installPath, lockedPackage(installPath, entry));
  }
  return result;
}

function lockedPackage(installPath: string, entry: JsonObject): LockedPackage {
  const declaredName = stringField(entry, 'name');
  return {
    install_path: installPath,
    name: declaredName ?? installDirectoryName(installPath),
    ...optionalString('version', stringField(entry, 'version')),
    ...optionalString('resolved', stringField(entry, 'resolved')),
    ...optionalString('integrity', stringField(entry, 'integrity')),
    dev: entry['dev'] === true,
  };
}

/**
 * The package name an install path installs: the path after its last `node_modules/`.
 *
 * @example
 * installDirectoryName('node_modules/a/node_modules/@s/b'); // '@s/b'
 */
export function installDirectoryName(installPath: string): string {
  const marker = installPath.lastIndexOf(NODE_MODULES_SEGMENT);
  return marker === -1 ? installPath : installPath.slice(marker + NODE_MODULES_SEGMENT.length);
}

function stringField(entry: JsonObject, key: string): string | undefined {
  const value = entry[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalString<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

function invalidLockfile(problem: string): StructuredReason {
  return scopeViolation('LOCKFILE_INVALID', `${PACKAGE_LOCK_PATH} ${problem}`);
}
