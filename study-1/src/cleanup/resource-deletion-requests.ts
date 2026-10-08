// Which delete request removes a remaining owned resource (BR-RUA-048 step 9, BR-RUA-050). The
// resource arrives as a surface named it: a stack listing gives CloudFormation's physical id, the
// tag index an ARN (a role by its name, `surface-readings-services.ts`). Each type's delete takes
// one form, so the identifier is read into it here and `aws/aws-resource-deleter.ts` only sends:
// - a function by name; a version through `DeleteFunction` with its version as `Qualifier`;
// - an alias through `DeleteAlias`; a mapping by UUID; a queue by URL (a queue ARN is read
//   into its URL); a table, log group or role by name;
// - a running durable execution is stopped, the only way it ends.
// Anything else (a stack, an inline policy, an unrecognized tag-index type) has no direct delete:
// BR-RUA-050 leaves a stack and what only it can remove to the stack boundary.

import { boundedJsonText } from '../record-contract/json-value.ts';
import type { StructuredReason } from '../record-contract/primitives.ts';
import type { DiscoveredResource } from './discovery.ts';
import { canonicalResourceName } from './resource-names.ts';
import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  LOG_GROUP_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from './resource-types.ts';
import { qualifiedFunctionParts } from './surface-readings-lambda.ts';
import { queueUrlOfIdentifier, roleNameOfArn } from './surface-readings-services.ts';

/** The one request that deletes a resource, with the identifier in the form it takes. */
export type DeletionRequest =
  | { readonly operation: 'DeleteFunction'; readonly function_name: string; readonly qualifier?: string }
  | { readonly operation: 'DeleteAlias'; readonly function_name: string; readonly alias_name: string }
  | { readonly operation: 'DeleteEventSourceMapping'; readonly mapping_id: string }
  | { readonly operation: 'DeleteQueue'; readonly queue_url: string }
  | { readonly operation: 'DeleteTable'; readonly table_name: string }
  | { readonly operation: 'DeleteLogGroup'; readonly log_group_name: string }
  | { readonly operation: 'DeleteRole'; readonly role_name: string }
  | { readonly operation: 'StopDurableExecution'; readonly execution_arn: string };

/** The request, or why the resource has no direct delete cleanup may send. */
export type DeletionPlan =
  | { readonly kind: 'request'; readonly request: DeletionRequest }
  | { readonly kind: 'unsupported'; readonly reason: StructuredReason };

type RequestBuilder = (identifier: string) => DeletionRequest | undefined;

// A Map, not an object literal, so an untrusted type such as `constructor` finds no builder.
const REQUEST_BUILDERS: ReadonlyMap<string, RequestBuilder> = new Map<string, RequestBuilder>([
  [FUNCTION_RESOURCE_TYPE, functionRequest],
  [FUNCTION_VERSION_RESOURCE_TYPE, versionRequest],
  [FUNCTION_ALIAS_RESOURCE_TYPE, aliasRequest],
  [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, mappingRequest],
  [QUEUE_RESOURCE_TYPE, queueRequest],
  [TABLE_RESOURCE_TYPE, tableRequest],
  [LOG_GROUP_RESOURCE_TYPE, logGroupRequest],
  [ROLE_RESOURCE_TYPE, roleRequest],
  [DURABLE_EXECUTION_RESOURCE_TYPE, durableExecutionRequest],
]);

/**
 * The delete request of one remaining owned resource, or why there is none.
 *
 * @example
 * deletionPlanOf({ resource_type: 'AWS::Lambda::Version', identifier: 'arn:aws:lambda:us-east-1:1:function:f:3', … });
 * // { kind: 'request', request: { operation: 'DeleteFunction', function_name: 'f', qualifier: '3' } }
 */
export function deletionPlanOf(resource: DiscoveredResource): DeletionPlan {
  const request = REQUEST_BUILDERS.get(resource.resource_type)?.(resource.identifier);
  if (request !== undefined) {
    return { kind: 'request', request };
  }
  return {
    kind: 'unsupported',
    reason: {
      code: 'DIRECT_DELETION_UNSUPPORTED',
      subject: resource.identifier,
      detail: `${resource.resource_type} named ${boundedJsonText(resource.identifier)} has no direct delete; expected a function, version, alias, event-source mapping, queue, table, log group, role or durable execution in the form its delete takes`,
    },
  };
}

function functionRequest(identifier: string): DeletionRequest {
  return { operation: 'DeleteFunction', function_name: canonicalResourceName(FUNCTION_RESOURCE_TYPE, identifier) };
}

function mappingRequest(identifier: string): DeletionRequest {
  const uuid = canonicalResourceName(EVENT_SOURCE_MAPPING_RESOURCE_TYPE, identifier);
  return { operation: 'DeleteEventSourceMapping', mapping_id: uuid };
}

function tableRequest(identifier: string): DeletionRequest {
  return { operation: 'DeleteTable', table_name: canonicalResourceName(TABLE_RESOURCE_TYPE, identifier) };
}

function logGroupRequest(identifier: string): DeletionRequest {
  return { operation: 'DeleteLogGroup', log_group_name: canonicalResourceName(LOG_GROUP_RESOURCE_TYPE, identifier) };
}

function roleRequest(identifier: string): DeletionRequest {
  return { operation: 'DeleteRole', role_name: roleNameOfArn(identifier) ?? identifier };
}

function durableExecutionRequest(identifier: string): DeletionRequest {
  return { operation: 'StopDurableExecution', execution_arn: identifier };
}

function versionRequest(identifier: string): DeletionRequest | undefined {
  const parts = qualifiedFunctionParts(identifier);
  return parts === undefined
    ? undefined
    : { operation: 'DeleteFunction', function_name: parts.function_name, qualifier: parts.qualifier };
}

function aliasRequest(identifier: string): DeletionRequest | undefined {
  const parts = qualifiedFunctionParts(identifier);
  return parts === undefined
    ? undefined
    : { operation: 'DeleteAlias', function_name: parts.function_name, alias_name: parts.qualifier };
}

function queueRequest(identifier: string): DeletionRequest | undefined {
  const url = queueUrlOfIdentifier(identifier);
  return url === undefined ? undefined : { operation: 'DeleteQueue', queue_url: url };
}
