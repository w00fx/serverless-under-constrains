// BR-RUA-050 conservative ownership (design §8.18), in rule order:
// 1. baseline and bootstrap resources are excluded and never touched;
// 2. the recorded stack is owned: it is the ownership boundary;
// 3. resource-manifest membership together with matching run-specific tags (`suc:run_id` and
//    `suc:study_id`) is owned and may be deleted directly;
// 4. a resource absent from a partial (or failed) manifest is owned only with the exact run tags
//    (every tag the manifest records) and an expected type or deterministic name and a creation
//    after the execution manifest froze;
// 5. a resource the recorded stack manages (its listing names it, or it is an untaggable
//    manifest member) is owned through the stack boundary. It is deleted only by deleting the
//    stack: BR-RUA-050 lets the stack, not the resource, be deleted on that basis;
// 6. everything else is ambiguous: never deleted, always reported.
// A generic project tag never counts: the tag rules read only run-specific tags.

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { OwnedBasis } from '../record-contract/records/group-c/vocabulary.ts';
import type { DiscoveredResource, ResourceTag } from './discovery.ts';
import type { OwnershipContext } from './ownership-context.ts';
import { RUN_ID_TAG, STUDY_ID_TAG } from './ownership-context.ts';
import { canonicalResourceName, resourceKey } from './resource-names.ts';
import { STACK_RESOURCE_TYPE } from './resource-types.ts';

export type OwnershipDecision =
  | { readonly kind: 'owned'; readonly basis: OwnedBasis }
  | { readonly kind: 'ambiguous'; readonly reasons: readonly [StructuredReason, ...StructuredReason[]] }
  | { readonly kind: 'excluded_baseline' };

/** The bases on which cleanup may delete a resource itself (BR-RUA-050 rules 3 and 4). */
export const DIRECTLY_DELETABLE_BASES: readonly OwnedBasis[] = [
  'resource_manifest_and_tags',
  'tags_name_type_created_after_freeze',
];

const SUBJECT = 'BR-RUA-050';

/**
 * Decides whether cleanup owns a discovered resource, conservatively (BR-RUA-050).
 *
 * @example
 * proveOwnership(resource, context); // { kind: 'owned', basis: 'resource_manifest_and_tags' }
 */
export function proveOwnership(resource: DiscoveredResource, context: OwnershipContext): OwnershipDecision {
  if (isBaseline(resource, context)) {
    return { kind: 'excluded_baseline' };
  }
  if (isRecordedStack(resource, context)) {
    return { kind: 'owned', basis: 'recorded_stack' };
  }
  const member = context.manifest_members.has(resourceKey(resource));
  if (member) {
    return decideManifestMember(resource, context);
  }
  const [firstFailure, ...otherFailures] = unrecordedOwnershipFailures(resource, context);
  if (firstFailure === undefined) {
    return { kind: 'owned', basis: 'tags_name_type_created_after_freeze' };
  }
  if (isManagedByRecordedStack(resource, context, false)) {
    return { kind: 'owned', basis: 'recorded_stack' };
  }
  return { kind: 'ambiguous', reasons: [firstFailure, ...otherFailures] };
}

/**
 * Whether cleanup may delete a resource of this basis itself, rather than through its stack.
 *
 * @example
 * isDirectlyDeletable('recorded_stack'); // false
 */
export function isDirectlyDeletable(basis: OwnedBasis): boolean {
  return DIRECTLY_DELETABLE_BASES.includes(basis);
}

// Rules 3 and 5 for a manifest member: run-specific tags, otherwise the stack boundary.
function decideManifestMember(resource: DiscoveredResource, context: OwnershipContext): OwnershipDecision {
  if (carriesRunSpecificTags(resource, context)) {
    return { kind: 'owned', basis: 'resource_manifest_and_tags' };
  }
  if (isManagedByRecordedStack(resource, context, true)) {
    return { kind: 'owned', basis: 'recorded_stack' };
  }
  return { kind: 'ambiguous', reasons: [tagReason(resource, `carry ${RUN_ID_TAG} and ${STUDY_ID_TAG}`)] };
}

function isBaseline(resource: DiscoveredResource, context: OwnershipContext): boolean {
  const name = canonicalResourceName(resource.resource_type, resource.identifier);
  return (
    context.baseline.names.includes(name) || context.baseline.name_prefixes.some((prefix) => name.startsWith(prefix))
  );
}

function isRecordedStack(resource: DiscoveredResource, context: OwnershipContext): boolean {
  return resource.resource_type === STACK_RESOURCE_TYPE && resource.identifier === context.recorded_stack_id;
}

function isManagedByRecordedStack(resource: DiscoveredResource, context: OwnershipContext, member: boolean): boolean {
  if (context.recorded_stack_id === undefined) {
    return false;
  }
  return resource.managed_by_stack_id === context.recorded_stack_id || (member && resource.tags.kind === 'untaggable');
}

function carriesRunSpecificTags(resource: DiscoveredResource, context: OwnershipContext): boolean {
  return (
    singleTagValue(resource, RUN_ID_TAG) === context.execution_id &&
    singleTagValue(resource, STUDY_ID_TAG) === context.study_id
  );
}

// Rule 4, for a resource absent from the manifest: every failed condition, in rule order.
function unrecordedOwnershipFailures(resource: DiscoveredResource, context: OwnershipContext): StructuredReason[] {
  const failures: StructuredReason[] = [];
  if (context.provisioning_status === 'succeeded') {
    failures.push(
      reason(
        'NOT_IN_COMPLETE_MANIFEST',
        `${describeResource(resource)} is absent from a succeeded resource manifest; expected a manifest member`,
      ),
    );
  }
  if (!context.run_tags.every((tag) => singleTagValue(resource, tag.key) === tag.value)) {
    failures.push(tagReason(resource, `carry every run tag ${describeTags(context.run_tags)}`));
  }
  if (!hasExpectedTypeOrName(resource, context)) {
    failures.push(
      reason(
        'UNEXPECTED_TYPE_AND_NAME',
        `${describeResource(resource)} has neither an execution stack type nor a deterministic name; expected one of them`,
      ),
    );
  }
  const creation = creationFailure(resource, context);
  return creation === undefined ? failures : [...failures, creation];
}

function hasExpectedTypeOrName(resource: DiscoveredResource, context: OwnershipContext): boolean {
  const name = canonicalResourceName(resource.resource_type, resource.identifier);
  return (
    context.expected_resource_types.has(resource.resource_type) ||
    context.deterministic_names.includes(name) ||
    context.deterministic_name_prefixes.some((prefix) => name.startsWith(prefix))
  );
}

function creationFailure(resource: DiscoveredResource, context: OwnershipContext): StructuredReason | undefined {
  if (resource.created_at === undefined) {
    return reason(
      'CREATION_TIME_UNKNOWN',
      `${describeResource(resource)} reports no creation time; expected one after ${context.execution_manifest_frozen_at}`,
    );
  }
  // UTC millisecond timestamps of one fixed width order lexicographically as they do in time.
  if (resource.created_at > context.execution_manifest_frozen_at) {
    return undefined;
  }
  return reason(
    'CREATED_BEFORE_MANIFEST_FREEZE',
    `${describeResource(resource)} created at ${resource.created_at}; expected after the execution manifest froze at ${context.execution_manifest_frozen_at}`,
  );
}

function singleTagValue(resource: DiscoveredResource, key: string): string | undefined {
  if (resource.tags.kind !== 'tagged') {
    return undefined;
  }
  const matching = resource.tags.tags.filter((tag) => tag.key === key);
  return matching.length === 1 ? matching[0]?.value : undefined;
}

function tagReason(resource: DiscoveredResource, expected: string): StructuredReason {
  return reason(
    'RUN_TAGS_NOT_PROVEN',
    `${describeResource(resource)} tags ${describeObservedTags(resource)}; expected to ${expected}`,
  );
}

function describeObservedTags(resource: DiscoveredResource): string {
  switch (resource.tags.kind) {
    case 'tagged':
      return describeTags(resource.tags.tags);
    case 'untaggable':
      return 'unsupported by its type';
    case 'unknown':
      return `unreadable (${resource.tags.reason.code})`;
  }
}

function describeTags(tags: readonly ResourceTag[]): string {
  return boundedJsonText(tags.map((tag) => `${tag.key}=${tag.value}`));
}

function describeResource(resource: DiscoveredResource): string {
  return `${resource.resource_type} ${boundedJsonText(resource.identifier)}`;
}

function reason(code: string, detail: string): StructuredReason {
  return { code, subject: SUBJECT, detail };
}
