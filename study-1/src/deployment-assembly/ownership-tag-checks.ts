// The ownership tags of an execution stack (BR-RUA-050; design §9.7; D-07). The frozen assembly
// declares them and the resource manifest records them, so cleanup can prove ownership later:
// - each of `suc:project`, `suc:study_id`, `suc:run_id`, `suc:managed_by` and `suc:expires_at`
//   exactly once, `suc:run_id` valued with the execution id (for all three kinds, D-07);
// - `suc:variant_id` at most once, only on a variant validation's stack, valued conventional or
//   durable: the run stack is shared and the probe stack belongs to no variant;
// - no other key, and no empty value or `@` (DynamoDB rejects it, [R-aws] §6.4).
// After deployment the stack's observed `suc:*` tags must equal the declared ones.

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason } from '../record-contract/primitives.ts';
import { OWNERSHIP_TAG_KEYS } from '../record-contract/records/group-a/resource_manifest.ts';
import type {
  KeyValueEntry,
  OwnershipTagEntry,
  OwnershipTagKey,
} from '../record-contract/records/group-a/resource_manifest.ts';
import { executionIdOf } from '../evidence-package/package-layout.ts';
import { deploymentReason } from './deployment-reasons.ts';

const VARIANT_TAG_KEY = 'suc:variant_id';
const VARIANT_VALUES: readonly string[] = ['conventional', 'durable'];
const OWNERSHIP_PREFIX = 'suc:';

/**
 * The declared tags as manifest entries sorted by key, or every reason they are not a valid
 * BR-RUA-050 set for this execution.
 *
 * @example
 * checkDeclaredTags({ execution_kind: 'RUN', run_id }, declared); // { ok: true, value: [...5 entries] }
 */
export function checkDeclaredTags(
  identity: ExecutionIdentity,
  tags: readonly KeyValueEntry[],
): Result<OwnershipTagEntry[], readonly StructuredReason[]> {
  const reasons = [
    ...tags.flatMap(entryProblems),
    ...OWNERSHIP_TAG_KEYS.flatMap((key) => countProblems(identity, tags, key)),
    ...runIdProblems(identity, tags),
  ];
  if (reasons.length > 0) {
    return err(reasons);
  }
  const entries = tags.map((tag) => ({ key: tag.key as OwnershipTagKey, value: tag.value }));
  return ok(entries.toSorted((a, b) => (a.key < b.key ? -1 : 1)));
}

/**
 * The reason the stack's observed `suc:*` tags differ from the declared ones, if they do.
 *
 * @example
 * observedTagReasons(declared, stack.tags); // [] when CloudFormation applied exactly the declared tags
 */
export function observedTagReasons(
  declared: readonly OwnershipTagEntry[],
  observed: readonly KeyValueEntry[],
): readonly StructuredReason[] {
  const expected = tagSet(declared);
  const actual = tagSet(observed.filter((tag) => tag.key.startsWith(OWNERSHIP_PREFIX)));
  const missing = [...expected].filter((tag) => !actual.has(tag));
  const extra = [...actual].filter((tag) => !expected.has(tag));
  if (missing.length === 0 && extra.length === 0) {
    return [];
  }
  return [
    tagReason(
      'OWNERSHIP_TAG_MISMATCH',
      `the stack lacks ${boundedJsonText(missing)} and adds ${boundedJsonText(extra)}; expected exactly the declared suc:* tags`,
    ),
  ];
}

function entryProblems(tag: KeyValueEntry): readonly StructuredReason[] {
  const knownKey = (OWNERSHIP_TAG_KEYS as readonly string[]).includes(tag.key);
  if (knownKey && tag.value !== '' && !tag.value.includes('@')) {
    return [];
  }
  return [
    tagReason(
      'OWNERSHIP_TAG_INVALID',
      `tag ${boundedJsonText(tag.key)}=${boundedJsonText(tag.value)}; expected a suc:* ownership key with a non-empty value without "@"`,
    ),
  ];
}

function countProblems(
  identity: ExecutionIdentity,
  tags: readonly KeyValueEntry[],
  key: OwnershipTagKey,
): readonly StructuredReason[] {
  const values = tags.filter((tag) => tag.key === key).map((tag) => tag.value);
  if (key !== VARIANT_TAG_KEY) {
    return values.length === 1 ? [] : [countReason(key, values.length, 'exactly once')];
  }
  if (values.length === 0) {
    return [];
  }
  const allowed = identity.execution_kind === 'VARIANT_VALIDATION' && values.length === 1;
  if (allowed && values.every((value) => VARIANT_VALUES.includes(value))) {
    return [];
  }
  return [
    tagReason(
      'OWNERSHIP_TAG_INVALID',
      `${VARIANT_TAG_KEY} ${boundedJsonText(values)} on a ${identity.execution_kind} stack; expected it only once, conventional or durable, on a VARIANT_VALIDATION stack`,
    ),
  ];
}

function runIdProblems(identity: ExecutionIdentity, tags: readonly KeyValueEntry[]): readonly StructuredReason[] {
  const executionId = executionIdOf(identity);
  const runIds = tags.filter((tag) => tag.key === 'suc:run_id' && tag.value !== executionId);
  return runIds.map((tag) =>
    tagReason(
      'OWNERSHIP_TAG_INVALID',
      `suc:run_id ${boundedJsonText(tag.value)}; expected the execution id ${executionId}`,
    ),
  );
}

function countReason(key: string, count: number, expected: string): StructuredReason {
  return tagReason('OWNERSHIP_TAG_INVALID', `${key} appears ${String(count)} times; expected it ${expected}`);
}

function tagSet(tags: readonly KeyValueEntry[]): ReadonlySet<string> {
  return new Set(tags.map((tag) => `${tag.key}=${tag.value}`));
}

function tagReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-050', detail);
}
