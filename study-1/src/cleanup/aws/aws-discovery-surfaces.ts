// AWS binding of `DiscoverySurfaces` (BR-RUA-051, design §9.14): the ten surfaces of the leak
// audit, bound to one execution's discovery targets, and the native describe that confirms a
// resource the tag index listed. The surfaces live in `lambda-surface-queries.ts` and
// `service-surface-queries.ts`; this class only routes. A query never throws: every failure is a
// failed surface, read by `sdk-call-outcomes.ts`.
//
// A tag-index entry of a type with no native describe here (an unrecognized ARN) is reported
// present: nothing proves it gone, so it stays visible to ownership and the audit.

import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { GetRoleCommand } from '@aws-sdk/client-iam';
import { GetEventSourceMappingCommand, GetFunctionCommand } from '@aws-sdk/client-lambda';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

import { ok } from '../../record-contract/primitives.ts';
import type { LeakAuditSurface } from '../../record-contract/records/group-c/vocabulary.ts';
import type { DiscoveredResource, DiscoverySurfaces, PresenceCheck, SurfaceQueryResult } from '../discovery.ts';
import type { DiscoveryTargets } from '../discovery-targets.ts';
import { canonicalResourceName } from '../resource-names.ts';
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
  TABLE_STREAM_RESOURCE_TYPE,
} from '../resource-types.ts';
import type { Described, SdkCallResult } from '../sdk-call-outcomes.ts';
import { described, describedPages, presenceOf, settleCleanupCall, surfaceAnswer } from '../sdk-call-outcomes.ts';
import type { Reading } from '../surface-readings.ts';
import {
  logGroupsPage,
  queueUrlOfIdentifier,
  roleNameOfArn,
  STACK_DELETE_COMPLETE,
  stackReading,
} from '../surface-readings-services.ts';
import type { CleanupAwsClients } from './cleanup-aws-clients.ts';
import { durableSurface, functionsSurface, mappingsSurface } from './lambda-surface-queries.ts';
import {
  logGroupsSurface,
  queuesSurface,
  rolesSurface,
  stackResourcesSurface,
  stackSurface,
  tablesSurface,
  tagIndexSurface,
} from './service-surface-queries.ts';

type SurfaceQuery = (
  clients: CleanupAwsClients,
  targets: DiscoveryTargets,
) => Promise<Reading<readonly DiscoveredResource[]>>;
type PresenceRead = (clients: CleanupAwsClients, identifier: string) => Promise<Described<boolean>>;

const SURFACE_QUERIES: Readonly<Record<LeakAuditSurface, SurfaceQuery>> = {
  tag_index: tagIndexSurface,
  stack: stackSurface,
  stack_resources: stackResourcesSurface,
  functions: (clients, targets) => functionsSurface(clients.lambda, targets),
  event_source_mappings: (clients, targets) => mappingsSurface(clients.lambda, targets),
  durable_executions: (clients, targets) => durableSurface(clients.lambda, targets),
  queues: queuesSurface,
  tables: tablesSurface,
  log_groups: logGroupsSurface,
  roles: rolesSurface,
};

// A Map, not an object literal, so an untrusted type such as `constructor` finds no reader.
const PRESENCE_READS: ReadonlyMap<string, PresenceRead> = new Map<string, PresenceRead>([
  [STACK_RESOURCE_TYPE, describeLiveStack],
  [FUNCTION_RESOURCE_TYPE, describeFunction],
  [FUNCTION_VERSION_RESOURCE_TYPE, describeFunction],
  [FUNCTION_ALIAS_RESOURCE_TYPE, describeFunction],
  [EVENT_SOURCE_MAPPING_RESOURCE_TYPE, describeMapping],
  [QUEUE_RESOURCE_TYPE, describeQueue],
  [TABLE_RESOURCE_TYPE, describeTable],
  // A table's stream outlives the table, DISABLED and undeletable, for up to 24 hours: it is
  // present only while its table exists (A-16; seen in the first real probe, decision 85).
  [TABLE_STREAM_RESOURCE_TYPE, describeStreamTable],
  [LOG_GROUP_RESOURCE_TYPE, describeLogGroup],
  [ROLE_RESOURCE_TYPE, describeRole],
]);

/**
 * The leak-audit surfaces of one execution.
 *
 * @example
 * const surfaces = new AwsDiscoverySurfaces(clients, targets);
 * await surfaces.query('queues'); // { ok: true, resources: [...] }
 */
export class AwsDiscoverySurfaces implements DiscoverySurfaces {
  readonly #clients: CleanupAwsClients;
  readonly #targets: DiscoveryTargets;

  constructor(clients: CleanupAwsClients, targets: DiscoveryTargets) {
    this.#clients = clients;
    this.#targets = targets;
  }

  /** Lists what one surface observes; a failure is a failed query, never a throw. */
  async query(surface: LeakAuditSurface): Promise<SurfaceQueryResult> {
    return surfaceAnswer(await SURFACE_QUERIES[surface](this.#clients, this.#targets));
  }

  /** The native describe of a tag-index entry: absent when the service no longer knows it. */
  async confirmPresence(resource: DiscoveredResource): Promise<PresenceCheck> {
    const read = PRESENCE_READS.get(resource.resource_type);
    return read === undefined ? { kind: 'present' } : presenceOf(await read(this.#clients, resource.identifier));
  }
}

async function exists(send: () => Promise<unknown>, subject: string, expected: string): Promise<Described<boolean>> {
  const call: SdkCallResult = await settleCleanupCall(send);
  return described(call, () => ok(true), subject, expected);
}

async function describeLiveStack(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  const call = await settleCleanupCall(() =>
    clients.cloudformation.send(new DescribeStacksCommand({ StackName: identifier })),
  );
  return described(
    call,
    (output) => {
      const stack = stackReading(output);
      return stack.ok ? ok(stack.value !== undefined && stack.value.status !== STACK_DELETE_COMPLETE) : stack;
    },
    identifier,
    'the stack description',
  );
}

// A function, version or alias is described by `GetFunction`, which takes a qualified ARN too.
// UNVERIFIED (cloud phase): that `GetFunction` on the qualified ARN of a deleted version or alias
// answers `ResourceNotFoundException` while the unqualified function still exists.
function describeFunction(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  return exists(
    () => clients.lambda.send(new GetFunctionCommand({ FunctionName: identifier })),
    identifier,
    'a function description',
  );
}

function describeMapping(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  const uuid = canonicalResourceName(EVENT_SOURCE_MAPPING_RESOURCE_TYPE, identifier);
  return exists(
    () => clients.lambda.send(new GetEventSourceMappingCommand({ UUID: uuid })),
    identifier,
    'an event-source mapping description',
  );
}

function describeTable(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  return describeTableNamed(clients, canonicalResourceName(TABLE_RESOURCE_TYPE, identifier), identifier);
}

function describeStreamTable(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  return describeTableNamed(clients, canonicalResourceName(TABLE_STREAM_RESOURCE_TYPE, identifier), identifier);
}

function describeTableNamed(clients: CleanupAwsClients, name: string, identifier: string): Promise<Described<boolean>> {
  return exists(
    () => clients.dynamodb.send(new DescribeTableCommand({ TableName: name })),
    identifier,
    'a table description',
  );
}

function describeRole(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  const name = roleNameOfArn(identifier) ?? identifier;
  return exists(() => clients.iam.send(new GetRoleCommand({ RoleName: name })), identifier, 'a role description');
}

async function describeQueue(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  const url = queueUrlOfIdentifier(identifier);
  if (url === undefined) {
    return { kind: 'found', value: true };
  }
  return exists(
    () => clients.sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] })),
    identifier,
    'the queue attributes',
  );
}

// DescribeLogGroups lists by prefix, so the group is present only when its exact name is listed.
async function describeLogGroup(clients: CleanupAwsClients, identifier: string): Promise<Described<boolean>> {
  const name = canonicalResourceName(LOG_GROUP_RESOURCE_TYPE, identifier);
  const listing = await describedPages(
    (cursor) =>
      settleCleanupCall(() =>
        clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name, nextToken: cursor })),
      ),
    logGroupsPage,
    identifier,
    'a listing of the log group',
  );
  return listing.kind === 'found'
    ? { kind: 'found', value: listing.value.some((group) => group.name === name) }
    : listing;
}
