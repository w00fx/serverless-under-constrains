// Ownership tags (design §9.7, BR-RUA-050; D-07). Run-owned stacks carry every `suc:*` tag;
// the coordination baseline carries only the project, study and manager tags. Tag values
// never contain `@`, which DynamoDB rejects ([R-aws] §6.4).

import { Tags } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';

import type { VariantId } from '../../src/record-contract/primitives.ts';
import { formatUtcMillis } from '../../src/record-contract/timestamps.ts';
import type { ExecutionSynthContext } from './execution-context.ts';

export const PROJECT_TAG = { key: 'suc:project', value: 'serverless-under-constraints' } as const;
export const STUDY_TAG = { key: 'suc:study_id', value: 'study-1' } as const;
export const MANAGED_BY_TAG = { key: 'suc:managed_by', value: 'rua-operator-cli' } as const;
export const RUN_ID_TAG_KEY = 'suc:run_id';
export const EXPIRES_AT_TAG_KEY = 'suc:expires_at';
export const VARIANT_TAG_KEY = 'suc:variant_id';

export interface OwnershipTag {
  readonly key: string;
  readonly value: string;
}

/**
 * Tags of the operator-managed coordination baseline (never cleaned up, never attributed).
 *
 * @example
 * applyOwnershipTags(coordinationStack, baselineTags());
 */
export function baselineTags(): readonly OwnershipTag[] {
  return [PROJECT_TAG, STUDY_TAG, MANAGED_BY_TAG];
}

/**
 * Tags of a run-owned execution stack: the baseline plus `suc:run_id` (the execution id for
 * all three kinds, D-07) and `suc:expires_at` (admitted_at plus the total target).
 *
 * @example
 * applyOwnershipTags(stack, executionOwnershipTags(context));
 */
export function executionOwnershipTags(context: ExecutionSynthContext): readonly OwnershipTag[] {
  const expiresAt = formatUtcMillis(new Date(Date.parse(context.admitted_at) + context.total_target_ms));
  return [
    ...baselineTags(),
    { key: RUN_ID_TAG_KEY, value: context.execution_id },
    { key: EXPIRES_AT_TAG_KEY, value: expiresAt },
  ];
}

/**
 * The tag that marks variant-owned resources.
 *
 * @example
 * applyOwnershipTags(conventionalConstruct, [variantTag('conventional')]);
 */
export function variantTag(variant: VariantId): OwnershipTag {
  return { key: VARIANT_TAG_KEY, value: variant };
}

/**
 * Applies tags to a construct subtree; tags propagate to every taggable child, including
 * event-source mappings (CF V-7).
 *
 * @example
 * applyOwnershipTags(stack, executionOwnershipTags(context));
 */
export function applyOwnershipTags(scope: IConstruct, tags: readonly OwnershipTag[]): void {
  for (const tag of tags) {
    if (tag.value.includes('@')) {
      throw new Error(
        `tag ${tag.key}=${JSON.stringify(tag.value)} contains "@"; expected DynamoDB-safe characters only`,
      );
    }
    Tags.of(scope).add(tag.key, tag.value);
  }
}
