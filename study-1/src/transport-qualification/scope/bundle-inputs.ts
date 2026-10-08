// The transitive production closure of one transport entry point (BR-RUA-028), as the bundler
// resolved it. The esbuild metafile lists every bundled file relative to the project root
// (design CF V-1); this module splits that list into project sources and npm packages.

/**
 * The bundling options the transport scope binds, as snapshot runtime properties. They mirror
 * the `ObservableFunction` bundling of `infra/constructs/observable-function.ts` (ESM, Node 24,
 * `module,main` main fields, AWS SDK bundled), and the esbuild resolver bundles with them.
 */
export const SCOPE_BUNDLE_RUNTIME_PROPERTIES = {
  bundle_aws_sdk: true,
  bundle_format: 'esm',
  bundle_main_fields: 'module,main',
  bundle_platform: 'node',
  bundle_target: 'node24',
} as const;

/** The bundled inputs of one entry point. */
export interface BundleInputs {
  readonly entry_point: string;
  /** Project files (paths relative to the project root), sorted and unique. */
  readonly local_sources: readonly string[];
  /** Package install paths as `package-lock.json` keys them (`node_modules/@scope/name`), sorted and unique. */
  readonly packages: readonly string[];
}

/**
 * Resolves the bundled inputs of each entry point, in the order given. Rejects when an entry
 * point or one of its imports cannot be resolved.
 */
export interface BundleInputResolver {
  /**
   * The bundling options this resolver resolves with, as snapshot runtime properties. The
   * snapshot binds these values, so it records the options that produced its closure.
   */
  readonly runtime_properties: Readonly<Record<string, string | number | boolean>>;
  resolve(entryPoints: readonly string[]): Promise<readonly BundleInputs[]>;
}

const NODE_MODULES = 'node_modules';

/**
 * Splits bundler input paths into project sources and package install paths.
 *
 * @example
 * classifyBundleInputs('src/a.ts', ['src/a.ts', 'node_modules/@smithy/types/dist-es/index.js']);
 * // { entry_point: 'src/a.ts', local_sources: ['src/a.ts'], packages: ['node_modules/@smithy/types'] }
 */
export function classifyBundleInputs(entryPoint: string, inputPaths: readonly string[]): BundleInputs {
  const localSources = new Set<string>();
  const packages = new Set<string>();
  for (const path of inputPaths) {
    const installPath = packageInstallPath(path);
    if (installPath === undefined) {
      localSources.add(path);
    } else {
      packages.add(installPath);
    }
  }
  return { entry_point: entryPoint, local_sources: sortedCodeUnits(localSources), packages: sortedCodeUnits(packages) };
}

/**
 * The install path of the innermost package that contains a file, or `undefined` for a file
 * outside every `node_modules` directory. Nested installs keep their full path, matching the
 * `package-lock.json` `packages` keys.
 *
 * @example
 * packageInstallPath('node_modules/a/node_modules/@s/b/lib/x.js'); // 'node_modules/a/node_modules/@s/b'
 * packageInstallPath('src/provider-client/arbiter.ts'); // undefined
 */
export function packageInstallPath(path: string): string | undefined {
  const segments = path.split('/');
  const marker = segments.lastIndexOf(NODE_MODULES, segments.length - 2);
  if (marker === -1) {
    return undefined;
  }
  const scoped = segments.slice(marker + 1, marker + 2).some((segment) => segment.startsWith('@'));
  const nameEnd = marker + (scoped ? 3 : 2);
  if (nameEnd > segments.length - 1) {
    return undefined;
  }
  return segments.slice(0, nameEnd).join('/');
}

/**
 * Sorts strings by UTF-16 code units, the order canonical JSON uses for keys.
 *
 * @example
 * sortedCodeUnits(new Set(['b', 'B', 'a'])); // ['B', 'a', 'b']
 */
export function sortedCodeUnits(values: Iterable<string>): readonly string[] {
  return [...values].sort(compareCodeUnits);
}

/**
 * Comparator by UTF-16 code units.
 *
 * @example
 * ['b', 'a'].sort(compareCodeUnits); // ['a', 'b']
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
