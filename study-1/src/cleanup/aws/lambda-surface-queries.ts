// The Lambda discovery surfaces of the leak audit (BR-RUA-051, design §9.14): functions with their
// versions and aliases, event-source mappings, and running durable executions. Each surface
// reads what the execution's discovery targets name; the SDK output is read and paged by the pure
// modules (`surface-readings-lambda.ts`, `sdk-call-outcomes.ts`). A function or mapping the
// service no longer knows is not sighted; any other failure fails the surface.

import {
  GetEventSourceMappingCommand,
  GetFunctionCommand,
  ListAliasesCommand,
  ListEventSourceMappingsCommand,
  ListTagsCommand,
  ListVersionsByFunctionCommand,
} from '@aws-sdk/client-lambda';
import type { LambdaClient } from '@aws-sdk/client-lambda';

import type { StructuredReason } from '../../record-contract/primitives.ts';
import type { DiscoveredResource, ResourceTag } from '../discovery.ts';
import type { DiscoveryTargets } from '../discovery-targets.ts';
import { EVENT_SOURCE_MAPPING_RESOURCE_TYPE, FUNCTION_RESOURCE_TYPE } from '../resource-types.ts';
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
import { tagMap } from '../surface-readings.ts';
import type { MappingReading } from '../surface-readings-lambda.ts';
import {
  durableExecutionsPage,
  functionAliasesPage,
  functionReading,
  functionVersionsPage,
  mappingReading,
  mappingsPage,
} from '../surface-readings-lambda.ts';
import { listDurableExecutions } from './lambda-durable-executions.ts';

type Sightings = Reading<readonly DiscoveredResource[]>;

// `ListEventSourceMappings` by function or by event source.
interface MappingFilter {
  readonly subject: string;
  readonly input: { readonly FunctionName?: string; readonly EventSourceArn?: string };
}

/**
 * `functions`: each recorded function (`GetFunction`, `ListTags`) with its published versions and
 * aliases.
 *
 * @example
 * await functionsSurface(clients.lambda, targets); // ok([function, version, alias])
 */
export function functionsSurface(lambda: LambdaClient, targets: DiscoveryTargets): Promise<Sightings> {
  return readingsOfEach(targets.function_names, (name) => functionSightings(lambda, name));
}

/**
 * `event_source_mappings`: the mappings of each recorded function and of each recorded queue,
 * and each recorded mapping UUID, once each, with their tags.
 *
 * @example
 * await mappingsSurface(clients.lambda, targets); // ok([mapping])
 */
export async function mappingsSurface(lambda: LambdaClient, targets: DiscoveryTargets): Promise<Sightings> {
  const filters: readonly MappingFilter[] = [
    ...targets.function_names.map((name) => ({ subject: name, input: { FunctionName: name } })),
    ...targets.event_source_arns.map((arn) => ({ subject: arn, input: { EventSourceArn: arn } })),
  ];
  const listed = await readingsOfEach(filters, async (filter) =>
    itemsOrNone(
      await describedPages(
        (cursor) =>
          settleCleanupCall(() => lambda.send(new ListEventSourceMappingsCommand({ ...filter.input, Marker: cursor }))),
        mappingsPage,
        filter.subject,
        'a listing of event-source mappings',
      ),
    ),
  );
  if (!listed.ok) {
    return listed;
  }
  const recorded = await readingsOfEach(targets.event_source_mapping_ids, (uuid) => recordedMapping(lambda, uuid));
  if (!recorded.ok) {
    return recorded;
  }
  const mappings = new Map([...listed.value, ...recorded.value].map((mapping) => [mapping.uuid, mapping]));
  return readingsOfEach([...mappings.values()], async (mapping) => {
    const tags = mapping.arn === undefined ? unlistedMappingArn(mapping.uuid) : await functionTags(lambda, mapping.arn);
    const sighted = { resource_type: EVENT_SOURCE_MAPPING_RESOURCE_TYPE, identifier: mapping.uuid };
    return { ok: true, value: sightingWithTags({ ...sighted, surface: 'event_source_mappings' }, tags) };
  });
}

/**
 * `durable_executions`: the `RUNNING` executions of the Durable functions, unqualified and under
 * each recorded version, owned through the recorded stack.
 *
 * @example
 * await durableSurface(clients.lambda, targets); // ok([execution])
 */
export async function durableSurface(lambda: LambdaClient, targets: DiscoveryTargets): Promise<Sightings> {
  const executions = await readingsOfEach(targets.durable_functions, (target) =>
    listDurableExecutions(lambda, target, (output) => durableExecutionsPage(output, targets.recorded_stack_id)),
  );
  if (!executions.ok) {
    return executions;
  }
  return { ok: true, value: [...new Map(executions.value.map((found) => [found.identifier, found])).values()] };
}

async function functionSightings(lambda: LambdaClient, name: string): Promise<Sightings> {
  const call = await settleCleanupCall(() => lambda.send(new GetFunctionCommand({ FunctionName: name })));
  const found = described(call, functionReading, name, 'a function description');
  if (found.kind !== 'found') {
    return nothingFound(found);
  }
  const tags = await functionTags(lambda, found.value.arn);
  const sighted = sightingWithTags(
    { resource_type: FUNCTION_RESOURCE_TYPE, identifier: found.value.name, surface: 'functions' },
    tags,
  );
  if (sighted.length === 0) {
    return { ok: true, value: [] };
  }
  const versions = await describedPages(
    (cursor) =>
      settleCleanupCall(() => lambda.send(new ListVersionsByFunctionCommand({ FunctionName: name, Marker: cursor }))),
    functionVersionsPage,
    name,
    'a listing of the function versions',
  );
  const aliases = await describedPages(
    (cursor) => settleCleanupCall(() => lambda.send(new ListAliasesCommand({ FunctionName: name, Marker: cursor }))),
    functionAliasesPage,
    name,
    'a listing of the function aliases',
  );
  const versionItems = itemsOrNone(versions);
  if (!versionItems.ok) {
    return versionItems;
  }
  const aliasItems = itemsOrNone(aliases);
  return aliasItems.ok ? { ok: true, value: [...sighted, ...versionItems.value, ...aliasItems.value] } : aliasItems;
}

async function recordedMapping(lambda: LambdaClient, uuid: string): Promise<Reading<readonly MappingReading[]>> {
  const call = await settleCleanupCall(() => lambda.send(new GetEventSourceMappingCommand({ UUID: uuid })));
  const mapping = described(call, mappingReading, uuid, 'an event-source mapping description');
  return mapping.kind === 'found' ? { ok: true, value: [mapping.value] } : nothingFound(mapping);
}

// Lambda `ListTags` takes a function ARN or an event-source mapping ARN.
async function functionTags(lambda: LambdaClient, arn: string): Promise<Described<readonly ResourceTag[]>> {
  const call = await settleCleanupCall(() => lambda.send(new ListTagsCommand({ Resource: arn })));
  return described(call, (output) => tagMap(output, 'Tags', 'ListTags'), arn, 'the resource tags');
}

function unlistedMappingArn(uuid: string): Described<readonly ResourceTag[]> {
  const reason: StructuredReason = {
    code: 'MAPPING_ARN_NOT_LISTED',
    subject: uuid,
    detail: 'the mapping was listed without its EventSourceMappingArn; expected the ARN its tags are read by',
  };
  return { kind: 'failed', reason };
}
