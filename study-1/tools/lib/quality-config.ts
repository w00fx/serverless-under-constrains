// Keeps `.c8rc.json` (coverage include/exclude) and `stryker.config.json` (`mutate`) equal to
// the issued mutation-target policy `quality/mutation-targets.json` (design §15.4, D-13).
// The patterns are globs, so files added or moved under a target directory are recomputed
// automatically; `--check` fails on any drift so neither config can quietly shrink the targets.
// The policy also records the human decision A-10: a type-only module (no runtime code under type
// stripping) is excluded from the targets. Its only accepted value is `excluded`, so the decision
// cannot be dropped or changed without editing this reader too.

/** How the policy treats type-only modules: excluded by the human decision A-10 (2026-10-05). */
export const TYPE_ONLY_POLICY = 'excluded';

export interface MutationTargetPolicy {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly type_only: typeof TYPE_ONLY_POLICY;
}

export type JsonRecord = Readonly<Record<string, unknown>>;

/**
 * Reads the policy, requiring non-empty `include`, an `exclude` list of glob strings and
 * `type_only: "excluded"` (human decision A-10).
 *
 * @example
 * parseMutationTargetPolicy({ include: ['src/**\/*.ts'], exclude: [], type_only: 'excluded' });
 */
export function parseMutationTargetPolicy(document: unknown): MutationTargetPolicy {
  const record = document as {
    readonly include?: unknown;
    readonly exclude?: unknown;
    readonly type_only?: unknown;
  } | null;
  const include = record?.include;
  const exclude = record?.exclude;
  if (
    !isStringList(include) ||
    include.length === 0 ||
    !isStringList(exclude) ||
    record?.type_only !== TYPE_ONLY_POLICY
  ) {
    throw new Error(
      `mutation-target policy is ${JSON.stringify(document)}; expected { include: [glob, ...] (non-empty), exclude: [glob, ...], type_only: "excluded" (human decision A-10) }`,
    );
  }
  return { include, exclude, type_only: TYPE_ONLY_POLICY };
}

/**
 * The Stryker `mutate` list: every include pattern, then every exclusion negated.
 *
 * @example
 * strykerMutatePatterns({ include: ['src/**\/*.ts'], exclude: ['src/**\/aws/**'] }); // ['src/**\/*.ts', '!src/**\/aws/**']
 */
export function strykerMutatePatterns(policy: MutationTargetPolicy): readonly string[] {
  return [...policy.include, ...policy.exclude.map((pattern) => `!${pattern}`)];
}

/**
 * Returns both configs with their target fields set from the policy; other fields are kept.
 *
 * @example
 * const { c8, stryker } = applyMutationTargets(policy, currentC8, currentStryker);
 */
export function applyMutationTargets(
  policy: MutationTargetPolicy,
  c8: JsonRecord,
  stryker: JsonRecord,
): { readonly c8: JsonRecord; readonly stryker: JsonRecord } {
  return {
    c8: { ...c8, include: [...policy.include], exclude: [...policy.exclude] },
    stryker: { ...stryker, mutate: [...strykerMutatePatterns(policy)] },
  };
}

/**
 * Lists every field that differs from what the policy requires.
 *
 * @example
 * qualityConfigDrift(policy, c8, stryker); // [] when both configs match the policy
 */
export function qualityConfigDrift(
  policy: MutationTargetPolicy,
  c8: JsonRecord,
  stryker: JsonRecord,
): readonly string[] {
  const expected = applyMutationTargets(policy, c8, stryker);
  const checks: readonly [string, unknown, unknown][] = [
    ['.c8rc.json include', c8['include'], expected.c8['include']],
    ['.c8rc.json exclude', c8['exclude'], expected.c8['exclude']],
    ['stryker.config.json mutate', stryker['mutate'], expected.stryker['mutate']],
  ];
  return checks
    .filter(([, actual, wanted]) => JSON.stringify(actual) !== JSON.stringify(wanted))
    .map(
      ([field, actual, wanted]) =>
        `${field} is ${JSON.stringify(actual)}; expected ${JSON.stringify(wanted)} from quality/mutation-targets.json`,
    );
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');
}
