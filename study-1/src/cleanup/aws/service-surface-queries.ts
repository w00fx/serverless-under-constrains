// The non-Lambda discovery surfaces of the leak audit (BR-RUA-051, design §9.14): the tag index,
// the recorded stack and what it lists, queues, tables, log groups and roles. Each surface reads
// what the execution's discovery targets name; SDK output is read and paged by the pure modules
// (`surface-readings-services.ts`, `sdk-call-outcomes.ts`). A resource the service no longer knows
// is not sighted; any other failure fails the surface.
//
// UNVERIFIED (cloud phase): how long the tag index keeps listing a deleted resource (each listed
// resource is confirmed by its native describe, `aws-discovery-surfaces.ts`).

import {
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import type { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DescribeLogGroupsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, ListTagsOfResourceCommand } from '@aws-sdk/client-dynamodb';
import { GetRoleCommand, ListRoleTagsCommand } from '@aws-sdk/client-iam';
import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ListQueueTagsCommand,
  ListQueuesCommand,
} from '@aws-sdk/client-sqs';

import type { DiscoveredResource } from '../discovery.ts';
import type { DiscoveryTargets } from '../discovery-targets.ts';
import { RUN_ID_TAG, STUDY_ID_TAG } from '../ownership-context.ts';
import {
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from '../resource-types.ts';
import type { Described } from '../sdk-call-outcomes.ts';
import {
  described,
  describedPages,
  itemsOrNone,
  nothingFound,
  readingsOfEach,
  settleCleanupCall,
  sightingWithTags,
} from '../sdk-call-outcomes.ts';
import type { Reading } from '../surface-readings.ts';
import { createdAt, tagMap } from '../surface-readings.ts';
import type { NamedReading, StackReading } from '../surface-readings-services.ts';
import {
  logGroupsPage,
  queueCreatedAt,
  queueUrlReading,
  queueUrlsPage,
  roleReading,
  roleTagsPage,
  skippedStackResourcesPage,
  stackReading,
  stackResourcesPage,
  stackSighting,
  tableReading,
  tableTagsPage,
  tagIndexPage,
} from '../surface-readings-services.ts';
import type { CleanupAwsClients } from './cleanup-aws-clients.ts';

type Sightings = Reading<readonly DiscoveredResource[]>;

/** The most queue URLs one `ListQueues` page returns; the API pages only when it is given. */
const LIST_QUEUES_PAGE_SIZE = 1000;

/**
 * `tag_index`: every resource tagged with the execution's `suc:run_id` and `suc:study_id`.
 *
 * @example
 * await tagIndexSurface(clients, targets); // ok([...listed ARNs])
 */
export async function tagIndexSurface(clients: CleanupAwsClients, targets: DiscoveryTargets): Promise<Sightings> {
  const tagFilters = [
    { Key: RUN_ID_TAG, Values: [targets.execution_id] },
    { Key: STUDY_ID_TAG, Values: [targets.study_id] },
  ];
  const listing = await describedPages(
    (cursor) =>
      settleCleanupCall(() =>
        clients.tagging.send(new GetResourcesCommand({ TagFilters: tagFilters, PaginationToken: cursor })),
      ),
    tagIndexPage,
    'tag_index',
    'a tag-index listing',
  );
  return itemsOrNone(listing);
}

/**
 * `stack`: the execution's stack, by recorded id (else by name), unless it is gone.
 *
 * @example
 * await stackSurface(clients, targets); // ok([stack]) while it exists
 */
export async function stackSurface(clients: CleanupAwsClients, targets: DiscoveryTargets): Promise<Sightings> {
  const stack = await describeStack(clients.cloudformation, targets.stack_ref);
  if (stack.kind !== 'found') {
    return nothingFound(stack);
  }
  const sighted = stackSighting(stack.value);
  return { ok: true, value: sighted === undefined ? [] : [sighted] };
}

/**
 * `stack_resources`: what the stack still lists, and what its deletion skipped (retained).
 *
 * @example
 * await stackResourcesSurface(clients, targets); // ok([...listed resources])
 */
export async function stackResourcesSurface(clients: CleanupAwsClients, targets: DiscoveryTargets): Promise<Sightings> {
  const stackId = targets.recorded_stack_id ?? (await unrecordedStackId(clients.cloudformation, targets.stack_ref));
  if (typeof stackId !== 'string') {
    return stackId;
  }
  const { cloudformation } = clients;
  const resources = await describedPages(
    (cursor) =>
      settleCleanupCall(() =>
        cloudformation.send(new ListStackResourcesCommand({ StackName: stackId, NextToken: cursor })),
      ),
    (output) => stackResourcesPage(output, stackId),
    stackId,
    'a listing of the stack resources',
  );
  const listed = itemsOrNone(resources);
  if (!listed.ok) {
    return listed;
  }
  const events = await describedPages(
    (cursor) =>
      settleCleanupCall(() =>
        cloudformation.send(new DescribeStackEventsCommand({ StackName: stackId, NextToken: cursor })),
      ),
    (output) => skippedStackResourcesPage(output, stackId),
    stackId,
    'a listing of the stack events',
  );
  const skipped = itemsOrNone(events);
  return skipped.ok ? { ok: true, value: [...listed.value, ...skipped.value] } : skipped;
}

/**
 * `queues`: the recorded queue names (`GetQueueUrl`) and every queue with the execution's name
 * prefix (`ListQueues`), each with its tags and creation time.
 *
 * @example
 * await queuesSurface(clients, targets); // ok([...queues])
 */
export async function queuesSurface(clients: CleanupAwsClients, targets: DiscoveryTargets): Promise<Sightings> {
  const { sqs } = clients;
  const named = await readingsOfEach<string, string>(targets.queue_names, async (name) => {
    const call = await settleCleanupCall(() => sqs.send(new GetQueueUrlCommand({ QueueName: name })));
    const url = described(call, queueUrlReading, name, 'the queue URL');
    return url.kind === 'found' ? { ok: true, value: [url.value] } : nothingFound(url);
  });
  if (!named.ok) {
    return named;
  }
  const listing = await describedPages(
    (cursor) =>
      settleCleanupCall(() =>
        sqs.send(
          new ListQueuesCommand({
            QueueNamePrefix: targets.queue_name_prefix,
            MaxResults: LIST_QUEUES_PAGE_SIZE,
            NextToken: cursor,
          }),
        ),
      ),
    queueUrlsPage,
    targets.queue_name_prefix,
    'a listing of the queues',
  );
  const listed = itemsOrNone(listing);
  if (!listed.ok) {
    return listed;
  }
  return readingsOfEach([...new Set([...named.value, ...listed.value])], (url) => queueSightings(clients, url));
}

/**
 * `tables`: the recorded and deterministic table names (`DescribeTable`), each with its tags.
 *
 * @example
 * await tablesSurface(clients, targets); // ok([...tables])
 */
export function tablesSurface(clients: CleanupAwsClients, targets: DiscoveryTargets): Promise<Sightings> {
  const { dynamodb } = clients;
  return readingsOfEach<string, DiscoveredResource>(targets.table_names, async (name) => {
    const call = await settleCleanupCall(() => dynamodb.send(new DescribeTableCommand({ TableName: name })));
    const table = described(call, tableReading, name, 'a table description');
    if (table.kind !== 'found') {
      return nothingFound(table);
    }
    const tags = await describedPages(
      (cursor) =>
        settleCleanupCall(() =>
          dynamodb.send(new ListTagsOfResourceCommand({ ResourceArn: table.value.arn, NextToken: cursor })),
        ),
      tableTagsPage,
      table.value.arn,
      'the table tags',
    );
    return { ok: true, value: sightingWithTags(namedSighting(TABLE_RESOURCE_TYPE, table.value, 'tables'), tags) };
  });
}

/**
 * `log_groups`: every log group under the execution's prefix, each with its tags.
 *
 * @example
 * await logGroupsSurface(clients, targets); // ok([...log groups])
 */
export async function logGroupsSurface(clients: CleanupAwsClients, targets: DiscoveryTargets): Promise<Sightings> {
  const { logs } = clients;
  const listing = await describedPages(
    (cursor) =>
      settleCleanupCall(() =>
        logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: targets.log_group_prefix, nextToken: cursor })),
      ),
    logGroupsPage,
    targets.log_group_prefix,
    'a listing of the log groups',
  );
  const groups = itemsOrNone(listing);
  if (!groups.ok) {
    return groups;
  }
  return readingsOfEach<NamedReading, DiscoveredResource>(groups.value, async (group) => {
    const call = await settleCleanupCall(() => logs.send(new ListTagsForResourceCommand({ resourceArn: group.arn })));
    const tags = described(
      call,
      (output) => tagMap(output, 'tags', 'ListTagsForResource'),
      group.arn,
      'the log group tags',
    );
    return { ok: true, value: sightingWithTags(namedSighting(LOG_GROUP_RESOURCE_TYPE, group, 'log_groups'), tags) };
  });
}

/**
 * `roles`: the recorded role names (`GetRole`), each with its tags.
 *
 * @example
 * await rolesSurface(clients, targets); // ok([...roles])
 */
export function rolesSurface(clients: CleanupAwsClients, targets: DiscoveryTargets): Promise<Sightings> {
  const { iam } = clients;
  return readingsOfEach<string, DiscoveredResource>(targets.role_names, async (name) => {
    const call = await settleCleanupCall(() => iam.send(new GetRoleCommand({ RoleName: name })));
    const role = described(call, roleReading, name, 'a role description');
    if (role.kind !== 'found') {
      return nothingFound(role);
    }
    const tags = await describedPages(
      (cursor) => settleCleanupCall(() => iam.send(new ListRoleTagsCommand({ RoleName: name, Marker: cursor }))),
      roleTagsPage,
      name,
      'the role tags',
    );
    return { ok: true, value: sightingWithTags(namedSighting(ROLE_RESOURCE_TYPE, role.value, 'roles'), tags) };
  });
}

async function queueSightings(clients: CleanupAwsClients, url: string): Promise<Sightings> {
  const { sqs } = clients;
  const attributes = await settleCleanupCall(() =>
    sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['CreatedTimestamp'] })),
  );
  const created = described(attributes, queueCreatedAt, url, 'the queue creation time');
  if (created.kind !== 'found') {
    return nothingFound(created);
  }
  const call = await settleCleanupCall(() => sqs.send(new ListQueueTagsCommand({ QueueUrl: url })));
  const tags = described(call, (output) => tagMap(output, 'Tags', 'ListQueueTags'), url, 'the queue tags');
  const sighted = { resource_type: QUEUE_RESOURCE_TYPE, identifier: url, surface: 'queues' as const };
  return { ok: true, value: sightingWithTags({ ...sighted, ...createdAt(created.value) }, tags) };
}

function namedSighting(
  resourceType: string,
  reading: NamedReading,
  surface: 'tables' | 'log_groups' | 'roles',
): Omit<DiscoveredResource, 'tags'> {
  return { resource_type: resourceType, identifier: reading.name, surface, ...createdAt(reading.created_at) };
}

async function describeStack(
  cloudformation: CloudFormationClient,
  stackRef: string,
): Promise<Described<StackReading | undefined>> {
  const call = await settleCleanupCall(() => cloudformation.send(new DescribeStacksCommand({ StackName: stackRef })));
  return described(call, stackReading, stackRef, 'the stack description');
}

// The id of a stack provisioning never recorded, read by its name; nothing sighted when it is gone.
async function unrecordedStackId(cloudformation: CloudFormationClient, stackName: string): Promise<string | Sightings> {
  const stack = await describeStack(cloudformation, stackName);
  if (stack.kind !== 'found') {
    return nothingFound(stack);
  }
  return stack.value?.stack_id ?? { ok: true, value: [] };
}
