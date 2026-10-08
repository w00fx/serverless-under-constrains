// Shared fixtures of the cleanup tests: one run execution, its resource manifest (design §9.2
// stack contents with the §9.7 deterministic names) and the ownership context cleanup builds
// from it, plus builders for discovered resources as each surface reports them.

import {
  logGroupName,
  queueName,
  resourceNamePrefix,
  roleName,
  stackName,
  tableName,
} from '../../../infra/ownership/resource-naming.ts';
import type { DiscoveredResource, ResourceTag, TagObservation } from '../../../src/cleanup/discovery.ts';
import type { OwnershipContext } from '../../../src/cleanup/ownership-context.ts';
import { ownershipContextFromManifest, STUDY_BASELINE_EXCLUSIONS } from '../../../src/cleanup/ownership-context.ts';
import {
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../../../src/cleanup/resource-types.ts';
import type { ExecutionIdentityFields } from '../../../src/record-contract/envelope.ts';
import type { ExecutionIdentity, Sha256Hex, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type {
  OwnershipTagEntry,
  ProvisioningStatus,
  ResourceManifest,
  StackResourceEntry,
} from '../../../src/record-contract/records/group-a/resource_manifest.ts';
import type { LeakAuditSurface } from '../../../src/record-contract/records/group-c/vocabulary.ts';

export const EXECUTION_ID = 'aaaaaaaa-0000-4000-8000-000000000001' as Uuid4;
export const OTHER_EXECUTION_ID = 'bbbbbbbb-0000-4000-8000-000000000002' as Uuid4;
export const EXECUTION: ExecutionIdentity = { execution_kind: 'RUN', run_id: EXECUTION_ID };
export const MANIFEST_SHA = 'a'.repeat(64) as Sha256Hex;
export const STUDY_ID = 'study-1';
export const STACK_NAME = stackName('RUN', EXECUTION_ID);
export const STACK_ID = `arn:aws:cloudformation:us-east-1:123456789012:stack/${STACK_NAME}/0f0e0d0c-0000-4000-8000-000000000001`;
export const ACCOUNT_SQS_HOST = 'https://sqs.us-east-1.amazonaws.com/123456789012';
/** Virtual time zero of every cleanup test. */
export const EPOCH_MS = Date.UTC(2026, 9, 5, 12, 0, 0, 0);
export const EXECUTION_FROZEN_AT = '2026-10-05T11:00:00.000Z' as UtcMillis;
export const AFTER_FREEZE = '2026-10-05T11:30:00.000Z' as UtcMillis;
export const BEFORE_FREEZE = '2026-10-05T10:00:00.000Z' as UtcMillis;

/** The deterministic names of the run's resources (design §9.7). */
export const NAMES = {
  providerFunction: `${resourceNamePrefix(EXECUTION_ID)}refund-provider`,
  durableFunction: `${resourceNamePrefix(EXECUTION_ID)}durable-caller`,
  controlTable: tableName(EXECUTION_ID, 'control'),
  durableDlqUrl: `${ACCOUNT_SQS_HOST}/${queueName(EXECUTION_ID, 'durable', 'dlq')}`,
  providerLogGroup: logGroupName(EXECUTION_ID, 'refund-provider'),
  providerRole: roleName(EXECUTION_ID, 'refund-provider'),
  sourceMapping: '5e5e5e5e-0000-4000-8000-000000000001',
} as const;

/** One stack member: how the manifest records it and the surface that lists it natively. */
export interface MemberSpec {
  readonly logical_id: string;
  readonly resource_type: string;
  readonly identifier: string;
  readonly surface: LeakAuditSurface;
}

/** The members of the run stack, one per surface type (design §9.2). */
export const STACK_MEMBERS: readonly MemberSpec[] = [
  {
    logical_id: 'ProviderFunction',
    resource_type: FUNCTION_RESOURCE_TYPE,
    identifier: NAMES.providerFunction,
    surface: 'functions',
  },
  {
    logical_id: 'DurableCaller',
    resource_type: FUNCTION_RESOURCE_TYPE,
    identifier: NAMES.durableFunction,
    surface: 'functions',
  },
  {
    logical_id: 'SourceMapping',
    resource_type: EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
    identifier: NAMES.sourceMapping,
    surface: 'event_source_mappings',
  },
  { logical_id: 'DurableDlq', resource_type: QUEUE_RESOURCE_TYPE, identifier: NAMES.durableDlqUrl, surface: 'queues' },
  { logical_id: 'ControlTable', resource_type: TABLE_RESOURCE_TYPE, identifier: NAMES.controlTable, surface: 'tables' },
  {
    logical_id: 'ProviderLogGroup',
    resource_type: LOG_GROUP_RESOURCE_TYPE,
    identifier: NAMES.providerLogGroup,
    surface: 'log_groups',
  },
  { logical_id: 'ProviderRole', resource_type: ROLE_RESOURCE_TYPE, identifier: NAMES.providerRole, surface: 'roles' },
];

/**
 * The five BR-RUA-050 ownership tags of `executionId`.
 *
 * @example
 * runTags().find((tag) => tag.key === 'suc:run_id')?.value; // EXECUTION_ID
 */
export function runTags(executionId: Uuid4 = EXECUTION_ID): OwnershipTagEntry[] {
  return [
    { key: 'suc:project', value: 'serverless-under-constraints' },
    { key: 'suc:study_id', value: STUDY_ID },
    { key: 'suc:run_id', value: executionId },
    { key: 'suc:managed_by', value: 'cdk' },
    { key: 'suc:expires_at', value: '2026-10-06T12:00:00.000Z' },
  ];
}

/** A stack resource listing names resources without reading their tags. */
export const STACK_LISTING_TAGS: TagObservation = {
  kind: 'unknown',
  reason: {
    code: 'TAGS_NOT_LISTED',
    subject: 'stack_resources',
    detail: 'ListStackResources returns no tags; expected none',
  },
};

/** A tag observation of exactly these tags. */
export function tagged(tags: readonly ResourceTag[] = runTags()): TagObservation {
  return { kind: 'tagged', tags };
}

/**
 * The run's resource manifest. A `succeeded` manifest records the stack id and every member; a
 * `partial` one may omit members (`members`) and the stack id (`withStack: false`).
 *
 * @example
 * resourceManifest('partial', { members: STACK_MEMBERS.slice(0, 2), withStack: false });
 */
export function resourceManifest(
  status: ProvisioningStatus = 'succeeded',
  options: {
    readonly members?: readonly MemberSpec[];
    readonly withStack?: boolean;
    readonly tags?: readonly OwnershipTagEntry[];
    /** The manifest's execution identity field (`{ run_id: EXECUTION_ID }` by default). */
    readonly identity?: ExecutionIdentityFields;
  } = {},
): ResourceManifest {
  const resources: StackResourceEntry[] = (options.members ?? STACK_MEMBERS).map((member) => ({
    logical_id: member.logical_id,
    resource_type: member.resource_type,
    physical_id: member.identifier,
    resource_status: 'CREATE_COMPLETE',
  }));
  const head = {
    schema_version: 1 as const,
    record_type: 'resource_manifest' as const,
    ...(options.identity ?? { run_id: EXECUTION_ID }),
    execution_manifest_sha256: MANIFEST_SHA,
    stack_name: STACK_NAME,
    resources,
    ownership_tags: options.tags ?? runTags(),
    outputs: [],
    deploy_started_at: '2026-10-05T11:05:00.000Z' as UtcMillis,
    frozen_at: '2026-10-05T11:20:00.000Z' as UtcMillis,
  };
  if (status === 'succeeded') {
    return {
      ...head,
      provisioning_status: 'succeeded',
      stack_id: STACK_ID,
      provider_version: '1',
      configuration: [{ logical_id: 'SourceMapping', attribute_path: 'BatchSize', canonical_json: '1' }],
      deploy_completed_at: '2026-10-05T11:19:00.000Z' as UtcMillis,
    };
  }
  return options.withStack === false
    ? { ...head, provisioning_status: status }
    : { ...head, provisioning_status: status, stack_id: STACK_ID };
}

/**
 * The ownership context of `manifest`; throws when the fixture manifest is refused.
 *
 * @example
 * ownershipContext(resourceManifest('partial')).provisioning_status; // 'partial'
 */
export function ownershipContext(manifest: ResourceManifest = resourceManifest()): OwnershipContext {
  const context = ownershipContextFromManifest({
    manifest,
    execution: EXECUTION,
    execution_manifest_frozen_at: EXECUTION_FROZEN_AT,
    baseline: STUDY_BASELINE_EXCLUSIONS,
  });
  if (!context.ok) {
    throw new Error(`fixture manifest refused: ${context.error.detail}; expected a valid ownership context`);
  }
  return context.value;
}

/**
 * A discovered resource; tagged with the run tags and created after the freeze unless overridden.
 *
 * @example
 * discovered(TABLE_RESOURCE_TYPE, 'suc1-aaaaaaaa-control', 'tables');
 */
export function discovered(
  resourceType: string,
  identifier: string,
  surface: LeakAuditSurface,
  overrides: Partial<Omit<DiscoveredResource, 'resource_type' | 'identifier' | 'surface'>> = {},
): DiscoveredResource {
  return { resource_type: resourceType, identifier, surface, tags: tagged(), created_at: AFTER_FREEZE, ...overrides };
}

/**
 * Resource types the Resource Groups Tagging API never returns, so a tag-index sighting of one
 * would be a fixture fiction: IAM roles, Lambda versions and aliases are not in tag-based groups
 * ([R-aws] §6.2, https://docs.aws.amazon.com/ARG/latest/userguide/supported-resources.html).
 */
export const NOT_ON_TAG_INDEX: readonly string[] = [
  ROLE_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
];

/**
 * Every sighting of the run's infrastructure as the surfaces report it while it exists: the
 * stack, its resource listing, each member on its native surface and, when the Tagging API
 * returns its type, on the tag index.
 *
 * @example
 * surfaces.place(...runInfrastructure());
 */
export function runInfrastructure(members: readonly MemberSpec[] = STACK_MEMBERS): DiscoveredResource[] {
  const stack = discovered(STACK_RESOURCE_TYPE, STACK_ID, 'stack');
  return [
    stack,
    ...members.flatMap((member) => [
      discovered(member.resource_type, member.identifier, member.surface),
      ...(NOT_ON_TAG_INDEX.includes(member.resource_type)
        ? []
        : [discovered(member.resource_type, member.identifier, 'tag_index')]),
      discovered(member.resource_type, member.identifier, 'stack_resources', {
        tags: STACK_LISTING_TAGS,
        managed_by_stack_id: STACK_ID,
      }),
    ]),
  ];
}
