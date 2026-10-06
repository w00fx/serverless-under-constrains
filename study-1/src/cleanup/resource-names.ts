// One name per resource, whatever surface saw it (BR-RUA-050 manifest membership, design
// §9.7 deterministic names). Surfaces name the same resource differently: CloudFormation
// records a queue by its URL while the tag index lists its ARN, and a stack's physical id is an
// ARN that embeds the stack name. Ownership and deduplication compare the canonical name, keyed
// by resource type because names are unique only per type.

import { QUEUE_RESOURCE_TYPE, STACK_RESOURCE_TYPE } from './resource-types.ts';

// arn:<partition>:cloudformation:<region>:<account>:stack/<name>/<guid>
const STACK_ARN_PATTERN = /^arn:[^:]+:cloudformation:[^:]*:[^:]*:stack\/([^/]+)\/[^/]+$/;
// https://<host>/<account>/<name>, the URL form of an SQS queue id
const QUEUE_URL_PATTERN = /^https:\/\/[^/]+\/[^/]+\/([^/]+)$/;

/**
 * The canonical name of a resource: the queue name of a queue URL, the stack name of a stack
 * ARN, and the identifier itself for every other type.
 *
 * @example
 * canonicalResourceName('AWS::SQS::Queue', 'https://sqs.us-east-1.amazonaws.com/123456789012/suc1-3f1c2a9e-durable-dlq.fifo');
 * // 'suc1-3f1c2a9e-durable-dlq.fifo'
 * canonicalResourceName('AWS::DynamoDB::Table', 'suc1-3f1c2a9e-control'); // 'suc1-3f1c2a9e-control'
 */
export function canonicalResourceName(resourceType: string, identifier: string): string {
  const pattern = namePattern(resourceType);
  const match = pattern === undefined ? null : pattern.exec(identifier);
  return match?.[1] ?? identifier;
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

function namePattern(resourceType: string): RegExp | undefined {
  if (resourceType === QUEUE_RESOURCE_TYPE) {
    return QUEUE_URL_PATTERN;
  }
  return resourceType === STACK_RESOURCE_TYPE ? STACK_ARN_PATTERN : undefined;
}
