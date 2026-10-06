// One name per resource, whatever surface saw it (BR-RUA-050 manifest membership, design
// §9.7 deterministic names). Surfaces name the same resource differently: CloudFormation
// records a queue by its URL while the tag index (`GetResources`, design §9.14) lists ARNs, and a
// stack's physical id is an ARN that embeds the stack name. Ownership and deduplication compare
// the canonical name, keyed by resource type because names are unique only per type.
//
// The ARN forms are those of the run's tag-discoverable types ([R-aws] §6.2): the tag-index
// adapter may hand them over as listed, and they still meet the manifest's physical ids. Only an
// unqualified function ARN names a function; a qualified one names a version or an alias.

import {
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  STACK_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from './resource-types.ts';

// arn:<partition>:cloudformation:<region>:<account>:stack/<name>/<guid>
const STACK_ARN_PATTERN = /^arn:[^:]+:cloudformation:[^:]*:[^:]*:stack\/([^/]+)\/[^/]+$/;
// https://<host>/<account>/<name>, the URL form of an SQS queue id
const QUEUE_URL_PATTERN = /^https:\/\/[^/]+\/[^/]+\/([^/]+)$/;
// arn:<partition>:sqs:<region>:<account>:<name>
const QUEUE_ARN_PATTERN = /^arn:[^:]+:sqs:[^:]*:[^:]*:([^:/]+)$/;
// arn:<partition>:lambda:<region>:<account>:function:<name>, unqualified
const FUNCTION_ARN_PATTERN = /^arn:[^:]+:lambda:[^:]*:[^:]*:function:([^:]+)$/;
// arn:<partition>:lambda:<region>:<account>:event-source-mapping:<uuid>
const EVENT_SOURCE_MAPPING_ARN_PATTERN = /^arn:[^:]+:lambda:[^:]*:[^:]*:event-source-mapping:([^:]+)$/;
// arn:<partition>:dynamodb:<region>:<account>:table/<name>
const TABLE_ARN_PATTERN = /^arn:[^:]+:dynamodb:[^:]*:[^:]*:table\/([^/]+)$/;
// arn:<partition>:logs:<region>:<account>:log-group:<name>, with the `:*` that DescribeLogGroups appends
const LOG_GROUP_ARN_PATTERN = /^arn:[^:]+:logs:[^:]*:[^:]*:log-group:([^:]+)(?::\*)?$/;

// A Map, not an object literal, so an untrusted type such as `constructor` finds no pattern.
const NAME_PATTERNS: ReadonlyMap<string, readonly RegExp[]> = new Map([
  [STACK_RESOURCE_TYPE, [STACK_ARN_PATTERN]],
  [QUEUE_RESOURCE_TYPE, [QUEUE_URL_PATTERN, QUEUE_ARN_PATTERN]],
  [FUNCTION_RESOURCE_TYPE, [FUNCTION_ARN_PATTERN]],
  [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, [EVENT_SOURCE_MAPPING_ARN_PATTERN]],
  [TABLE_RESOURCE_TYPE, [TABLE_ARN_PATTERN]],
  [LOG_GROUP_RESOURCE_TYPE, [LOG_GROUP_ARN_PATTERN]],
]);

/**
 * The canonical name of a resource: the queue name of a queue URL or ARN, the stack name of a
 * stack ARN, the name (or mapping UUID) inside the ARN of a function, mapping, table or log
 * group, and the identifier itself otherwise.
 *
 * @example
 * canonicalResourceName('AWS::SQS::Queue', 'https://sqs.us-east-1.amazonaws.com/123456789012/suc1-3f1c2a9e-durable-dlq.fifo');
 * // 'suc1-3f1c2a9e-durable-dlq.fifo'
 * canonicalResourceName('AWS::DynamoDB::Table', 'arn:aws:dynamodb:us-east-1:123456789012:table/suc1-3f1c2a9e-control');
 * // 'suc1-3f1c2a9e-control'
 */
export function canonicalResourceName(resourceType: string, identifier: string): string {
  for (const pattern of NAME_PATTERNS.get(resourceType) ?? []) {
    const name = pattern.exec(identifier)?.[1];
    if (name !== undefined) {
      return name;
    }
  }
  return identifier;
}

/**
 * The comparison key of a resource: its type and canonical name.
 *
 * @example
 * resourceKey({ resource_type: 'AWS::Lambda::Function', identifier: 'suc1-3f1c2a9e-provider' });
 * // 'AWS::Lambda::Function|suc1-3f1c2a9e-provider'
 */
export function resourceKey(resource: { readonly resource_type: string; readonly identifier: string }): string {
  return `${resource.resource_type}|${canonicalResourceName(resource.resource_type, resource.identifier)}`;
}
