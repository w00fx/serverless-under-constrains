// Step A12's ownership strategy (SAFETY; BR-RUA-046 "missing ownership strategy", BR-RUA-050,
// design §8.17, §9.7, D-07). Before admission freezes an assembly it proves the synthesized stack
// declares the ownership tags that cleanup and billing attribution later rely on. The cloud
// assembly manifest records them under `artifacts.<stack>.properties.tags`: the tags `cdk deploy`
// applies to the stack and CloudFormation propagates to its resources (the pinned CDK 2 writes
// them there; `ownership-strategy.integration.test.ts` proves it on a real synthesis).
// Each of the five BR-RUA-050 stack keys must be declared with a non-empty value without "@"
// (DynamoDB rejects it, [R-aws] §6.4); `suc:run_id` must be this execution's id (D-07); and
// `suc:expires_at` must be the admission instant plus the kind's total target. The expected
// values are recomputed here from the synthesis context instead of being imported from
// `infra/ownership/ownership-tags.ts`, so the check stays independent of the code it checks.
// `suc:variant_id` marks only the variant subtrees of a validation, never the stack.
// Untrusted assembly bytes are read with own members only and quoted bounded (A-05).

import { boundedJsonText, describeJson, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonObject, JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import { OWNERSHIP_TAG_KEYS } from '../record-contract/records/group-a/resource_manifest.ts';
import type { OwnershipTagKey } from '../record-contract/records/group-a/resource_manifest.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import type { ExecutionSynthContext } from '../../infra/ownership/execution-context.ts';
import { ownField } from '../trial-message/trial-message-fields.ts';
import { admissionReason } from './admission-reason.ts';
import type { AssemblyDirectory } from './assembly-files.ts';

/** The cloud assembly manifest at the root of every synthesized assembly. */
export const ASSEMBLY_MANIFEST_FILE = 'manifest.json';

/** The BR-RUA-050 keys every execution stack declares, in the spec's order. */
export const STACK_OWNERSHIP_TAG_KEYS: readonly OwnershipTagKey[] = OWNERSHIP_TAG_KEYS.filter(
  (key) => key !== 'suc:variant_id',
);

type StackTagsReading =
  { readonly tags: JsonObject; readonly found?: undefined } | { readonly tags?: undefined; readonly found: string };

/**
 * Every reason the synthesized stack `stackName` lacks the BR-RUA-050 ownership strategy of the
 * execution `context` describes; empty when it declares it.
 *
 * @example
 * ownershipStrategyReasons(context, directory, 'SucRua-run-3f1c2a9e'); // [] for a real synthesis
 */
export function ownershipStrategyReasons(
  context: ExecutionSynthContext,
  directory: AssemblyDirectory,
  stackName: string,
): readonly StructuredReason[] {
  const reading = stackTagsOf(directory, stackName);
  if (reading.tags === undefined) {
    return [
      admissionReason(
        'OWNERSHIP_STRATEGY_MISSING',
        'BR-RUA-046',
        `${reading.found}; expected artifacts.${boundedJsonText(stackName)}.properties.tags declaring ${STACK_OWNERSHIP_TAG_KEYS.join(', ')}`,
      ),
    ];
  }
  const expected = expectedTagValues(context);
  const tags = reading.tags;
  return STACK_OWNERSHIP_TAG_KEYS.flatMap((key) => tagReasons(key, ownField(tags, key), expected.get(key)));
}

function stackTagsOf(directory: AssemblyDirectory, stackName: string): StackTagsReading {
  const file = directory.files.find((candidate) => candidate.path === ASSEMBLY_MANIFEST_FILE);
  if (file === undefined) {
    return { found: `the assembly has no ${ASSEMBLY_MANIFEST_FILE}` };
  }
  const parsed = parseJsonDocument(file.bytes);
  if (!parsed.ok) {
    return { found: `${ASSEMBLY_MANIFEST_FILE} is not JSON (${parsed.error.kind})` };
  }
  const tags = ['artifacts', stackName, 'properties', 'tags'].reduce<JsonValue | undefined>(
    (value, name) => (isJsonObject(value) ? ownField(value, name) : undefined),
    parsed.value,
  );
  if (!isJsonObject(tags)) {
    return { found: `${ASSEMBLY_MANIFEST_FILE} declares stack tags ${describeJson(tags)}` };
  }
  return { tags };
}

// `suc:expires_at` is the admission instant plus the total target (design §9.7).
function expectedTagValues(context: ExecutionSynthContext): ReadonlyMap<OwnershipTagKey, string> {
  const expiresAt = formatUtcMillis(new Date(Date.parse(context.admitted_at) + context.total_target_ms));
  return new Map<OwnershipTagKey, string>([
    ['suc:run_id', context.execution_id],
    ['suc:expires_at', expiresAt],
  ]);
}

function tagReasons(
  key: OwnershipTagKey,
  value: JsonValue | undefined,
  expected: string | undefined,
): readonly StructuredReason[] {
  const usable = typeof value === 'string' && value !== '' && !value.includes('@');
  if (usable && (expected === undefined || value === expected)) {
    return [];
  }
  const shape = expected === undefined ? 'a non-empty string without "@"' : JSON.stringify(expected);
  return [
    admissionReason(
      'OWNERSHIP_TAG_INVALID',
      'BR-RUA-050',
      `stack tag ${key} is ${describeJson(value)}; expected ${shape}`,
    ),
  ];
}
