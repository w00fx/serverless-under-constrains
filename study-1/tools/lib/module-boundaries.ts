// The import rules of design §5.4, evaluated over parsed import lists. A module may import
// only from strictly lower layers, plus the declared same-layer edges; some features carry
// hard denials (I/O, the AWS SDK, adapter paths, isolation-breaking features or tokens).
// `infra/` may import only the features listed for it, and `src/` may reach into `infra/`
// only through the listed infra paths.

import { posix } from 'node:path';

import type { ImportReference } from './source-imports.ts';

export interface SameLayerEdge {
  readonly from: string;
  readonly to: string;
  /** When present, the import must resolve under one of these paths inside `to`. */
  readonly paths?: readonly string[];
  /** When true, only type-only imports may use the edge. */
  readonly type_only?: boolean;
}

export interface DeniedImports {
  readonly features: readonly string[];
  /** Exact specifiers, such as `fs` or `child_process`. */
  readonly specifiers: readonly string[];
  readonly specifier_prefixes: readonly string[];
  readonly path_segments: readonly string[];
}

export interface DeniedFeatureImports {
  readonly features: readonly string[];
  readonly targets: readonly string[];
}

export interface DeniedTokens {
  readonly features: readonly string[];
  readonly tokens: readonly string[];
}

export interface BoundaryConfig {
  readonly layers: Readonly<Record<string, number>>;
  readonly same_layer_edges: readonly SameLayerEdge[];
  readonly denied_imports: readonly DeniedImports[];
  readonly denied_feature_imports: readonly DeniedFeatureImports[];
  readonly denied_tokens: readonly DeniedTokens[];
  readonly infra_may_import: readonly string[];
  readonly src_may_import_infra: readonly string[];
}

export interface CheckedSourceFile {
  /** POSIX path relative to the study root, such as `src/trial-oracle/verdict.ts`. */
  readonly path: string;
  readonly text: string;
  readonly imports: readonly ImportReference[];
}

export interface BoundaryViolation {
  readonly path: string;
  readonly rule: string;
  readonly detail: string;
}

type Location =
  { readonly area: 'src'; readonly feature: string } | { readonly area: 'infra' } | { readonly area: 'other' };

interface SourceOrigin {
  readonly feature: string;
  readonly layer: number;
}

/**
 * Checks every file and returns each violation with the offending import and the rule.
 *
 * @example
 * checkModuleBoundaries(config, files); // [] when every import points inward
 */
export function checkModuleBoundaries(
  config: BoundaryConfig,
  files: readonly CheckedSourceFile[],
): readonly BoundaryViolation[] {
  return files.flatMap((file) => checkFile(config, file));
}

function checkFile(config: BoundaryConfig, file: CheckedSourceFile): readonly BoundaryViolation[] {
  const from = locate(file.path);
  if (from.area === 'infra') {
    return file.imports.flatMap((reference) => infraImportViolations(config, file.path, reference));
  }
  if (from.area === 'other') {
    return [];
  }
  const layer = config.layers[from.feature];
  if (layer === undefined) {
    const detail = `src/${from.feature} is not a feature folder declared in quality/module-boundaries.json layers`;
    return [violation(file.path, 'UNDECLARED_FEATURE', detail)];
  }
  const origin = { feature: from.feature, layer };
  const tokenViolations = deniedTokenViolations(config, from.feature, file);
  return [
    ...tokenViolations,
    ...file.imports.flatMap((reference) => checkSourceImport(config, file.path, origin, reference)),
  ];
}

function checkSourceImport(
  config: BoundaryConfig,
  path: string,
  origin: SourceOrigin,
  reference: ImportReference,
): readonly BoundaryViolation[] {
  const denied = deniedImportViolations(config, path, origin.feature, reference);
  const resolved = resolveRelative(path, reference);
  if (resolved === undefined) {
    return denied;
  }
  return [...denied, ...edgeViolations(config, path, origin, reference, resolved)];
}

function edgeViolations(
  config: BoundaryConfig,
  path: string,
  origin: SourceOrigin,
  reference: ImportReference,
  resolved: string,
): readonly BoundaryViolation[] {
  const target = locate(resolved);
  if (target.area === 'other') {
    return [
      violation(
        path,
        'IMPORT_OUTSIDE_SOURCE',
        `${reference.specifier} resolves to ${resolved}; expected src/ or an allowed infra path`,
      ),
    ];
  }
  if (target.area === 'infra') {
    const allowed = config.src_may_import_infra.some((prefix) => resolved.startsWith(prefix));
    const detail = `${reference.specifier} resolves to ${resolved}; src may import only ${config.src_may_import_infra.join(', ')}`;
    return allowed ? [] : [violation(path, 'SRC_IMPORTS_INFRA', detail)];
  }
  if (target.feature === origin.feature) {
    return [];
  }
  const featureDenial = config.denied_feature_imports.find(
    (rule) => rule.features.includes(origin.feature) && rule.targets.includes(target.feature),
  );
  if (featureDenial !== undefined) {
    return [
      violation(
        path,
        'DENIED_FEATURE_IMPORT',
        `${origin.feature} must not import ${target.feature} (${reference.specifier})`,
      ),
    ];
  }
  return layerViolations(config, path, origin, reference, target.feature, resolved);
}

function layerViolations(
  config: BoundaryConfig,
  path: string,
  origin: SourceOrigin,
  reference: ImportReference,
  toFeature: string,
  resolved: string,
): readonly BoundaryViolation[] {
  const toLayer = config.layers[toFeature];
  if (toLayer === undefined) {
    return [
      violation(
        path,
        'UNDECLARED_FEATURE',
        `${reference.specifier} resolves into undeclared feature ${JSON.stringify(toFeature)}`,
      ),
    ];
  }
  if (toLayer < origin.layer) {
    return [];
  }
  const edge = config.same_layer_edges.find(
    (candidate) => candidate.from === origin.feature && candidate.to === toFeature,
  );
  if (toLayer > origin.layer || edge === undefined) {
    return [
      violation(
        path,
        'OUTWARD_IMPORT',
        `${origin.feature} (L${String(origin.layer)}) imports ${toFeature} (L${String(toLayer)}) via ${reference.specifier}; expected a strictly lower layer or a declared same-layer edge`,
      ),
    ];
  }
  return sameLayerEdgeViolations(path, edge, reference, resolved);
}

function sameLayerEdgeViolations(
  path: string,
  edge: SameLayerEdge,
  reference: ImportReference,
  resolved: string,
): readonly BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  const allowedPaths = edge.paths ?? [];
  if (allowedPaths.length > 0 && !allowedPaths.some((prefix) => resolved.startsWith(`src/${edge.to}/${prefix}`))) {
    violations.push(
      violation(
        path,
        'EDGE_PATH_NOT_ALLOWED',
        `${reference.specifier} resolves to ${resolved}; the ${edge.from} -> ${edge.to} edge allows only ${allowedPaths.join(', ')}`,
      ),
    );
  }
  if (edge.type_only === true && !reference.typeOnly) {
    violations.push(
      violation(
        path,
        'EDGE_REQUIRES_TYPE_ONLY',
        `${reference.specifier} is a value import; the ${edge.from} -> ${edge.to} edge allows type-only imports`,
      ),
    );
  }
  return violations;
}

function deniedImportViolations(
  config: BoundaryConfig,
  path: string,
  feature: string,
  reference: ImportReference,
): readonly BoundaryViolation[] {
  const specifier = reference.specifier;
  return config.denied_imports
    .filter((rule) => rule.features.includes(feature))
    .filter((rule) => matchesDenial(rule, specifier))
    .map((rule) => {
      const denied = [...rule.specifiers, ...rule.specifier_prefixes, ...rule.path_segments].join(', ');
      return violation(path, 'DENIED_IMPORT', `${feature} must not import ${specifier} (denied: ${denied})`);
    });
}

function matchesDenial(rule: DeniedImports, specifier: string): boolean {
  return (
    rule.specifiers.includes(specifier) ||
    rule.specifier_prefixes.some((prefix) => specifier.startsWith(prefix)) ||
    rule.path_segments.some((segment) => specifier.includes(segment))
  );
}

function deniedTokenViolations(
  config: BoundaryConfig,
  feature: string,
  file: CheckedSourceFile,
): readonly BoundaryViolation[] {
  return config.denied_tokens
    .filter((rule) => rule.features.includes(feature))
    .flatMap((rule) => rule.tokens.filter((token) => file.text.includes(token)))
    .map((token) => violation(file.path, 'DENIED_TOKEN', `${feature} must not reference ${token}`));
}

function infraImportViolations(
  config: BoundaryConfig,
  path: string,
  reference: ImportReference,
): readonly BoundaryViolation[] {
  const resolved = resolveRelative(path, reference);
  const target = resolved === undefined ? undefined : locate(resolved);
  if (target?.area !== 'src' || config.infra_may_import.includes(target.feature)) {
    return [];
  }
  return [
    violation(
      path,
      'INFRA_IMPORTS_FEATURE_CODE',
      `${reference.specifier} reaches src/${target.feature}; infra may import only ${config.infra_may_import.join(', ')}`,
    ),
  ];
}

// Bare specifiers (packages, node: built-ins) resolve outside the study tree.
function resolveRelative(path: string, reference: ImportReference): string | undefined {
  return reference.specifier.startsWith('.') ? posix.join(posix.dirname(path), reference.specifier) : undefined;
}

function locate(path: string): Location {
  const normalized = posix.normalize(path);
  if (normalized.startsWith('src/')) {
    // A file directly under src/ belongs to no feature; '' is never a declared layer.
    return { area: 'src', feature: /^src\/([^/]+)\//.exec(normalized)?.[1] ?? '' };
  }
  if (normalized.startsWith('infra/')) {
    return { area: 'infra' };
  }
  return { area: 'other' };
}

function violation(path: string, rule: string, detail: string): BoundaryViolation {
  return { path, rule, detail };
}

/**
 * Validates `quality/module-boundaries.json`: layers are nonnegative integers, and every
 * edge, denial and infra rule names declared features.
 *
 * @example
 * const config = parseBoundaryConfig(JSON.parse(readFileSync('quality/module-boundaries.json', 'utf8')));
 */
export function parseBoundaryConfig(document: unknown): BoundaryConfig {
  const config = document as Partial<Readonly<Record<keyof BoundaryConfig, unknown>>> | null;
  const layers = config?.layers;
  if (!isLayerMap(layers)) {
    throw new Error(
      `layers is ${JSON.stringify(layers)}; expected an object of feature name to nonnegative integer layer`,
    );
  }
  const lists = [
    'same_layer_edges',
    'denied_imports',
    'denied_feature_imports',
    'denied_tokens',
    'infra_may_import',
    'src_may_import_infra',
  ] as const;
  const absent = lists.filter((key) => !Array.isArray(config?.[key]));
  if (absent.length > 0) {
    throw new Error(
      `module boundaries lack array field(s) ${absent.join(', ')}; expected every rule list to be present`,
    );
  }
  const parsed = config as unknown as BoundaryConfig;
  const unknown = referencedFeatures(parsed).filter((feature) => layers[feature] === undefined);
  if (unknown.length > 0) {
    throw new Error(
      `rules name undeclared feature(s) ${[...new Set(unknown)].join(', ')}; expected every feature to have a layer`,
    );
  }
  return parsed;
}

function referencedFeatures(config: BoundaryConfig): readonly string[] {
  return [
    ...config.same_layer_edges.flatMap((edge) => [edge.from, edge.to]),
    ...config.denied_imports.flatMap((rule) => rule.features),
    ...config.denied_feature_imports.flatMap((rule) => [...rule.features, ...rule.targets]),
    ...config.denied_tokens.flatMap((rule) => rule.features),
    ...config.infra_may_import,
  ];
}

function isLayerMap(value: unknown): value is Readonly<Record<string, number>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isLayer);
}

function isLayer(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
