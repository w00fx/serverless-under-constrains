// Pure readings of the Tagging API, CloudFormation, SQS, DynamoDB, CloudWatch Logs and IAM SDK
// output for cleanup (design §9.14). A resource is named by the physical id CloudFormation records
// for it (BR-RUA-050 membership): a queue by its URL, a table, log group or role by its name, a
// stack by its id. A tag-index entry keeps the ARN as listed; `canonicalResourceName` meets it
// with the physical id. Untrusted output rules of `surface-readings.ts` apply.

import { ok } from '../record-contract/primitives.ts';
import type { UtcMillis } from '../record-contract/primitives.ts';
import type { DiscoveredResource, ResourceTag, TagObservation } from './discovery.ts';
import type { ReceivedDlqMessage } from './dlq-message-deletion.ts';
import { canonicalResourceName } from './resource-names.ts';
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
} from './resource-types.ts';
import type { Page, Reading } from './surface-readings.ts';
import {
  createdAt,
  instantOfMillis,
  malformedOutput,
  optionalInstant,
  optionalText,
  ownMember,
  pageWithCursor,
  readEachEntry,
  requiredText,
  sighting,
  tagPairs,
} from './surface-readings.ts';
import { LATEST_VERSION, qualifiedFunctionParts } from './surface-readings-lambda.ts';

/** The pseudo type of a tag-index ARN of no type cleanup knows; nothing proves what it can do. */
export const UNRECOGNIZED_TAGGED_RESOURCE_TYPE = 'AWS::ResourceGroupsTaggingAPI::TaggedResource';
export const STACK_DELETE_COMPLETE = 'DELETE_COMPLETE';
/** The tag observation of a stack listing, which names resources without their tags. */
export const STACK_LISTING_TAGS: TagObservation = {
  kind: 'unknown',
  reason: {
    code: 'TAGS_NOT_LISTED',
    subject: 'stack_resources',
    detail: 'stack listings return no tags; expected none',
  },
};

const DELETE_SKIPPED = 'DELETE_SKIPPED';
const VERSION_QUALIFIER = /^[0-9]+$/;
// arn:<partition>:iam::<account>:role/<path/><name>
const ROLE_ARN = /^arn:[^:]+:iam::[^:]*:role\/(?:.*\/)?([^/]+)$/;
// arn:<partition>:sqs:<region>:<account>:<name>
const QUEUE_ARN = /^arn:[^:]+:sqs:([^:]+):([^:]+):([^:/]+)$/;
const ARN_NAMED_TYPES = [
  STACK_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
];
// https://<host>/<account>/<name>, the queue URL CloudFormation records.
const QUEUE_URL = /^https:\/\/[^/]+\/[^/]+\/[^/]+$/;
const EPOCH_SECONDS_TEXT = /^(0|[1-9][0-9]{0,11})$/;
const LOG_GROUP_ARN_SUFFIX = /:\*$/;

/**
 * One page of the Resource Groups Tagging API `GetResources`: every listed ARN with its tags; a
 * role is named by its role name, its CloudFormation physical id.
 *
 * @example
 * tagIndexPage({ ResourceTagMappingList: [{ ResourceARN: arn, Tags: [] }], PaginationToken: '' });
 */
export function tagIndexPage(output: unknown): Reading<Page<DiscoveredResource>> {
  const resources = readEachEntry(output, 'ResourceTagMappingList', 'GetResources', (mapping, where) => {
    const arn = requiredText(mapping, 'ResourceARN', where);
    if (!arn.ok) {
      return arn;
    }
    const tags = tagPairs(mapping, where);
    if (!tags.ok) {
      return tags;
    }
    const type = resourceTypeOfArn(arn.value);
    // A role's physical id is its name, which `canonicalResourceName` cannot read from an ARN.
    const roleName = type === ROLE_RESOURCE_TYPE ? roleNameOfArn(arn.value) : undefined;
    return ok(sighting(type, roleName ?? arn.value, 'tag_index', { kind: 'tagged', tags: tags.value }));
  });
  return resources.ok ? pageWithCursor(resources.value, output, 'GetResources', 'PaginationToken') : resources;
}

/**
 * The resource type a tag-index ARN names, or `UNRECOGNIZED_TAGGED_RESOURCE_TYPE`.
 *
 * @example
 * resourceTypeOfArn('arn:aws:lambda:us-east-1:123456789012:function:f:3'); // 'AWS::Lambda::Version'
 */
export function resourceTypeOfArn(arn: string): string {
  const named = ARN_NAMED_TYPES.find((type) => canonicalResourceName(type, arn) !== arn);
  if (named !== undefined) {
    return named;
  }
  const qualifier = qualifiedFunctionParts(arn)?.qualifier;
  if (qualifier !== undefined) {
    return qualifier === LATEST_VERSION || VERSION_QUALIFIER.test(qualifier)
      ? FUNCTION_VERSION_RESOURCE_TYPE
      : FUNCTION_ALIAS_RESOURCE_TYPE;
  }
  return roleNameOfArn(arn) === undefined ? UNRECOGNIZED_TAGGED_RESOURCE_TYPE : ROLE_RESOURCE_TYPE;
}

/**
 * The role name inside an IAM role ARN.
 *
 * @example
 * roleNameOfArn('arn:aws:iam::123456789012:role/suc1-aaaaaaaa-provider'); // 'suc1-aaaaaaaa-provider'
 */
export function roleNameOfArn(arn: string): string | undefined {
  return ROLE_ARN.exec(arn)?.[1];
}

/**
 * The queue URL of an SQS queue ARN (`https://sqs.<region>.amazonaws.com/<account>/<name>`).
 *
 * @example
 * queueUrlOfArn('arn:aws:sqs:us-east-1:123456789012:q.fifo'); // 'https://sqs.us-east-1.amazonaws.com/123456789012/q.fifo'
 */
export function queueUrlOfArn(arn: string): string | undefined {
  const [, region, account, name] = QUEUE_ARN.exec(arn) ?? [];
  if (region === undefined || account === undefined || name === undefined) {
    return undefined;
  }
  return `https://sqs.${region}.amazonaws.com/${account}/${name}`;
}

/**
 * The queue URL a queue identifier names: a URL as is, an ARN read into its URL.
 *
 * @example
 * queueUrlOfIdentifier('arn:aws:sqs:us-east-1:123456789012:q'); // 'https://sqs.us-east-1.amazonaws.com/123456789012/q'
 */
export function queueUrlOfIdentifier(identifier: string): string | undefined {
  return QUEUE_URL.test(identifier) ? identifier : queueUrlOfArn(identifier);
}

/** What `DescribeStacks` says of the one stack it was asked for. */
export interface StackReading {
  readonly stack_id: string;
  readonly status: string;
  readonly tags: readonly ResourceTag[];
  readonly created_at?: UtcMillis;
}

/**
 * The single stack of a `DescribeStacks` answer, or `undefined` when it lists none.
 *
 * @example
 * stackReading({ Stacks: [{ StackId: id, StackStatus: 'CREATE_COMPLETE', CreationTime: new Date() }] });
 */
export function stackReading(output: unknown): Reading<StackReading | undefined> {
  const stacks = readEachEntry(output, 'Stacks', 'DescribeStacks', (stack, where) => {
    const id = requiredText(stack, 'StackId', where);
    if (!id.ok) {
      return id;
    }
    const status = requiredText(stack, 'StackStatus', where);
    if (!status.ok) {
      return status;
    }
    const tags = tagPairs(stack, where);
    if (!tags.ok) {
      return tags;
    }
    const created = optionalInstant(stack, 'CreationTime', where);
    return created.ok
      ? ok({ stack_id: id.value, status: status.value, tags: tags.value, ...createdAt(created.value) })
      : created;
  });
  if (!stacks.ok || stacks.value.length <= 1) {
    return stacks.ok ? ok(stacks.value[0]) : stacks;
  }
  return malformedOutput('DescribeStacks', 'Stacks', stacks.value.length, 'at most the one stack asked for');
}

/**
 * The stack as the `stack` surface sees it; a `DELETE_COMPLETE` stack is gone.
 *
 * @example
 * stackSighting({ stack_id: id, status: 'DELETE_COMPLETE', tags: [] }); // undefined
 */
export function stackSighting(stack: StackReading | undefined): DiscoveredResource | undefined {
  if (stack === undefined || stack.status === STACK_DELETE_COMPLETE) {
    return undefined;
  }
  const tags: TagObservation = { kind: 'tagged', tags: stack.tags };
  return { ...sighting(STACK_RESOURCE_TYPE, stack.stack_id, 'stack', tags), ...createdAt(stack.created_at) };
}

/**
 * One page of `ListStackResources`: every resource the stack still manages, by physical id. A
 * resource never created (no physical id) or already `DELETE_COMPLETE` is not listed.
 *
 * @example
 * stackResourcesPage({ StackResourceSummaries: [summary], NextToken: 't' }, stackId);
 */
export function stackResourcesPage(output: unknown, stackId: string): Reading<Page<DiscoveredResource>> {
  return stackListingPage(output, ['StackResourceSummaries', 'ListStackResources'], stackId, (status) => {
    return status !== STACK_DELETE_COMPLETE;
  });
}

/**
 * One page of `DescribeStackEvents`, keeping the resources whose deletion was skipped
 * (`DELETE_SKIPPED`: retained by a deletion policy, so they outlive the stack).
 *
 * @example
 * skippedStackResourcesPage({ StackEvents: [event] }, stackId);
 */
export function skippedStackResourcesPage(output: unknown, stackId: string): Reading<Page<DiscoveredResource>> {
  return stackListingPage(output, ['StackEvents', 'DescribeStackEvents'], stackId, (status) => {
    return status === DELETE_SKIPPED;
  });
}

/**
 * The URL `GetQueueUrl` answers.
 *
 * @example
 * queueUrlReading({ QueueUrl: url }); // ok(url)
 */
export function queueUrlReading(output: unknown): Reading<string> {
  return requiredText(output, 'QueueUrl', 'GetQueueUrl');
}

/**
 * One page of `ListQueues`: queue URLs (an empty account omits the list).
 *
 * @example
 * queueUrlsPage({ QueueUrls: [url], NextToken: 't' }); // ok({ items: [url], cursor: 't' })
 */
export function queueUrlsPage(output: unknown): Reading<Page<string>> {
  const urls = readEachEntry(output, 'QueueUrls', 'ListQueues', (url, where) =>
    typeof url === 'string' && url.length > 0 ? ok(url) : malformedOutput(where, 'QueueUrl', url, 'a queue URL'),
  );
  return urls.ok ? pageWithCursor(urls.value, output, 'ListQueues', 'NextToken') : urls;
}

/**
 * The creation time `GetQueueAttributes` reports in `CreatedTimestamp` (epoch seconds).
 *
 * @example
 * queueCreatedAt({ Attributes: { CreatedTimestamp: '1791201600' } }); // ok('2026-10-05T12:00:00.000Z')
 */
export function queueCreatedAt(output: unknown): Reading<UtcMillis | undefined> {
  const seconds = ownMember(ownMember(output, 'Attributes'), 'CreatedTimestamp');
  if (seconds === undefined) {
    return ok(undefined);
  }
  const digits = typeof seconds === 'string' && EPOCH_SECONDS_TEXT.test(seconds);
  const instant = digits ? instantOfMillis(Number(seconds) * 1000) : undefined;
  return instant === undefined
    ? malformedOutput('GetQueueAttributes.Attributes', 'CreatedTimestamp', seconds, 'epoch seconds as digits')
    : ok(instant);
}

/**
 * The messages one `ReceiveMessage` returned, by id and receipt handle (none: no `Messages`).
 *
 * @example
 * receivedDlqMessages({ Messages: [{ MessageId: 'm1', ReceiptHandle: 'r1' }] });
 * // ok([{ message_id: 'm1', receipt_handle: 'r1' }])
 */
export function receivedDlqMessages(output: unknown): Reading<readonly ReceivedDlqMessage[]> {
  return readEachEntry(output, 'Messages', 'ReceiveMessage', (message, where) => {
    const id = requiredText(message, 'MessageId', where);
    if (!id.ok) {
      return id;
    }
    const receipt = requiredText(message, 'ReceiptHandle', where);
    return receipt.ok ? ok({ message_id: id.value, receipt_handle: receipt.value }) : receipt;
  });
}

/** A described table, role or log group: its name, the ARN its tags are read by, its creation time. */
export interface NamedReading {
  readonly name: string;
  readonly arn: string;
  readonly created_at?: UtcMillis;
}

/**
 * The table `DescribeTable` describes.
 *
 * @example
 * tableReading({ Table: { TableName: 't', TableArn: arn, CreationDateTime: date } });
 */
export function tableReading(output: unknown): Reading<NamedReading> {
  return namedReading(ownMember(output, 'Table'), 'DescribeTable.Table', ['TableName', 'TableArn', 'CreationDateTime']);
}

/**
 * The role `GetRole` describes.
 *
 * @example
 * roleReading({ Role: { RoleName: 'r', Arn: arn, CreateDate: date } });
 */
export function roleReading(output: unknown): Reading<NamedReading> {
  return namedReading(ownMember(output, 'Role'), 'GetRole.Role', ['RoleName', 'Arn', 'CreateDate']);
}

/**
 * One page of DynamoDB `ListTagsOfResource`: `[{ Key, Value }]` tags continued by `NextToken`.
 *
 * @example
 * tableTagsPage({ Tags: [{ Key: 'suc:run_id', Value: id }], NextToken: 't' }); // ok({ items: [...], cursor: 't' })
 */
export function tableTagsPage(output: unknown): Reading<Page<ResourceTag>> {
  const tags = tagPairs(output, 'ListTagsOfResource');
  return tags.ok ? pageWithCursor(tags.value, output, 'ListTagsOfResource', 'NextToken') : tags;
}

/**
 * One page of IAM `ListRoleTags`: `[{ Key, Value }]` tags continued by `Marker` while `IsTruncated`.
 *
 * @example
 * roleTagsPage({ Tags: [], IsTruncated: true, Marker: 'm' }); // ok({ items: [], cursor: 'm' })
 */
export function roleTagsPage(output: unknown): Reading<Page<ResourceTag>> {
  const tags = tagPairs(output, 'ListRoleTags');
  if (!tags.ok) {
    return tags;
  }
  if (ownMember(output, 'IsTruncated') !== true) {
    return ok({ items: tags.value });
  }
  const marker = requiredText(output, 'Marker', 'ListRoleTags');
  return marker.ok ? ok({ items: tags.value, cursor: marker.value }) : marker;
}

/**
 * One page of `DescribeLogGroups`. The tag ARN is `logGroupArn`, or `arn` without the `:*` that
 * `DescribeLogGroups` appends; `creationTime` is epoch milliseconds.
 *
 * @example
 * logGroupsPage({ logGroups: [{ logGroupName: n, arn: `${a}:*`, creationTime: 1791201600000 }] });
 */
export function logGroupsPage(output: unknown): Reading<Page<NamedReading>> {
  const groups = readEachEntry(output, 'logGroups', 'DescribeLogGroups', (group, where) => {
    const name = requiredText(group, 'logGroupName', where);
    if (!name.ok) {
      return name;
    }
    const arn = logGroupTagArn(group, where);
    if (!arn.ok) {
      return arn;
    }
    const millis = ownMember(group, 'creationTime');
    const created = instantOfMillis(millis);
    if (millis !== undefined && created === undefined) {
      return malformedOutput(where, 'creationTime', millis, 'epoch milliseconds in years 0000-9999');
    }
    return ok({ name: name.value, arn: arn.value, ...createdAt(created) });
  });
  return groups.ok ? pageWithCursor(groups.value, output, 'DescribeLogGroups', 'nextToken') : groups;
}

function logGroupTagArn(group: unknown, at: string): Reading<string> {
  const arn = optionalText(group, 'logGroupArn', at);
  if (!arn.ok) {
    return arn;
  }
  if (arn.value !== undefined) {
    return ok(arn.value);
  }
  const listed = requiredText(group, 'arn', at);
  return listed.ok ? ok(listed.value.replace(LOG_GROUP_ARN_SUFFIX, '')) : listed;
}

function stackListingPage(
  output: unknown,
  [listKey, at]: readonly [string, string],
  stackId: string,
  keep: (status: string) => boolean,
): Reading<Page<DiscoveredResource>> {
  const entries = readEachEntry(output, listKey, at, (entry, where) => {
    const type = requiredText(entry, 'ResourceType', where);
    if (!type.ok) {
      return type;
    }
    const status = requiredText(entry, 'ResourceStatus', where);
    if (!status.ok) {
      return status;
    }
    // CloudFormation reports a resource it never created with an empty physical id.
    const physical =
      ownMember(entry, 'PhysicalResourceId') === '' ? ok(undefined) : optionalText(entry, 'PhysicalResourceId', where);
    if (!physical.ok) {
      return physical;
    }
    if (physical.value === undefined || !keep(status.value)) {
      return ok([]);
    }
    const listed = sighting(type.value, physical.value, 'stack_resources', STACK_LISTING_TAGS);
    return ok([{ ...listed, managed_by_stack_id: stackId }]);
  });
  return entries.ok ? pageWithCursor(entries.value.flat(), output, at, 'NextToken') : entries;
}

function namedReading(holder: unknown, at: string, keys: readonly [string, string, string]): Reading<NamedReading> {
  const [nameKey, arnKey, createdKey] = keys;
  const name = requiredText(holder, nameKey, at);
  if (!name.ok) {
    return name;
  }
  const arn = requiredText(holder, arnKey, at);
  if (!arn.ok) {
    return arn;
  }
  const created = optionalInstant(holder, createdKey, at);
  return created.ok ? ok({ name: name.value, arn: arn.value, ...createdAt(created.value) }) : created;
}
