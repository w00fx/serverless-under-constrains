// Pure readings of Lambda SDK output for cleanup (design §9.14 functions, event-source mappings
// and durable executions; RK-10). Each reading names a resource by the physical id CloudFormation
// records for it: a function by its name, a version or alias by its ARN, a mapping by its UUID.
// Versions, aliases and durable executions carry no tags ([R-aws] §6.2); a durable execution
// belongs to the stack that manages its function (WP-19 decision 145). Untrusted output rules of
// `surface-readings.ts` apply.

import { ok } from '../record-contract/primitives.ts';
import type { LeakAuditSurface } from '../record-contract/records/group-c/vocabulary.ts';
import type { DiscoveredResource } from './discovery.ts';
import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  FUNCTION_ALIAS_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
} from './resource-types.ts';
import type { Page, Reading } from './surface-readings.ts';
import {
  createdAt,
  optionalInstant,
  optionalText,
  ownMember,
  pageWithCursor,
  readEachEntry,
  requiredText,
  sighting,
} from './surface-readings.ts';

/** The qualifier of the unpublished function code; it names the function itself. */
export const LATEST_VERSION = '$LATEST';
const RUNNING = 'RUNNING';
// arn:<partition>:lambda:<region>:<account>:function:<name>:<qualifier>
const QUALIFIED_FUNCTION_ARN = /^(arn:[^:]+:lambda:[^:]*:[^:]*:function:([^:]+)):([^:]+)$/;

/** The parts of a version or alias ARN. */
export interface QualifiedFunctionArn {
  /** The unqualified function ARN. */
  readonly function_arn: string;
  readonly function_name: string;
  /** A version number, `$LATEST` or an alias name. */
  readonly qualifier: string;
}

/**
 * The unqualified function ARN, function name and qualifier of a version or alias ARN.
 *
 * @example
 * qualifiedFunctionParts('arn:aws:lambda:us-east-1:1:function:f:live');
 * // { function_arn: 'arn:aws:lambda:us-east-1:1:function:f', function_name: 'f', qualifier: 'live' }
 */
export function qualifiedFunctionParts(arn: string): QualifiedFunctionArn | undefined {
  const [, functionArn, functionName, qualifier] = QUALIFIED_FUNCTION_ARN.exec(arn) ?? [];
  if (functionArn === undefined || functionName === undefined || qualifier === undefined) {
    return undefined;
  }
  return { function_arn: functionArn, function_name: functionName, qualifier };
}

/**
 * The function `GetFunction` describes: its name (the CloudFormation physical id) and ARN.
 *
 * @example
 * functionReading({ Configuration: { FunctionName: 'f', FunctionArn: arn } }); // ok({ name: 'f', arn })
 */
export function functionReading(output: unknown): Reading<{ readonly name: string; readonly arn: string }> {
  const configuration = ownMember(output, 'Configuration');
  const name = requiredText(configuration, 'FunctionName', 'GetFunction.Configuration');
  if (!name.ok) {
    return name;
  }
  const arn = requiredText(configuration, 'FunctionArn', 'GetFunction.Configuration');
  return arn.ok ? ok({ name: name.value, arn: arn.value }) : arn;
}

/**
 * One page of `ListVersionsByFunction`: each published version by its ARN; `$LATEST` is the
 * function itself and is not listed.
 *
 * @example
 * functionVersionsPage({ Versions: [{ FunctionArn: `${arn}:1`, Version: '1' }], NextMarker: 'm' });
 */
export function functionVersionsPage(output: unknown): Reading<Page<DiscoveredResource>> {
  const at = 'ListVersionsByFunction';
  const versions = readEachEntry(output, 'Versions', at, (version, where) => {
    const arn = requiredText(version, 'FunctionArn', where);
    if (!arn.ok) {
      return arn;
    }
    const number = requiredText(version, 'Version', where);
    if (!number.ok) {
      return number;
    }
    return ok(number.value === LATEST_VERSION ? [] : [untaggable(FUNCTION_VERSION_RESOURCE_TYPE, arn.value)]);
  });
  return versions.ok ? pageWithCursor(versions.value.flat(), output, at, 'NextMarker') : versions;
}

/**
 * One page of `ListAliases`: each alias by its ARN.
 *
 * @example
 * functionAliasesPage({ Aliases: [{ AliasArn: `${arn}:live` }] });
 */
export function functionAliasesPage(output: unknown): Reading<Page<DiscoveredResource>> {
  const aliases = readEachEntry(output, 'Aliases', 'ListAliases', (alias, where) => {
    const arn = requiredText(alias, 'AliasArn', where);
    return arn.ok ? ok(untaggable(FUNCTION_ALIAS_RESOURCE_TYPE, arn.value)) : arn;
  });
  return aliases.ok ? pageWithCursor(aliases.value, output, 'ListAliases', 'NextMarker') : aliases;
}

/** An event-source mapping: its UUID (the physical id), its state and its ARN when listed. */
export interface MappingReading {
  readonly uuid: string;
  readonly state: string;
  readonly arn?: string;
}

/**
 * The mapping `GetEventSourceMapping` describes (or one entry of a listing).
 *
 * @example
 * mappingReading({ UUID: uuid, State: 'Disabled' }); // ok({ uuid, state: 'Disabled' })
 */
export function mappingReading(output: unknown, at = 'GetEventSourceMapping'): Reading<MappingReading> {
  const uuid = requiredText(output, 'UUID', at);
  if (!uuid.ok) {
    return uuid;
  }
  const state = requiredText(output, 'State', at);
  if (!state.ok) {
    return state;
  }
  const arn = optionalText(output, 'EventSourceMappingArn', at);
  if (!arn.ok) {
    return arn;
  }
  return ok({ uuid: uuid.value, state: state.value, ...(arn.value === undefined ? {} : { arn: arn.value }) });
}

/**
 * One page of `ListEventSourceMappings`.
 *
 * @example
 * mappingsPage({ EventSourceMappings: [{ UUID: uuid, State: 'Enabled' }], NextMarker: 'm' });
 */
export function mappingsPage(output: unknown): Reading<Page<MappingReading>> {
  const at = 'ListEventSourceMappings';
  const mappings = readEachEntry(output, 'EventSourceMappings', at, mappingReading);
  return mappings.ok ? pageWithCursor(mappings.value, output, at, 'NextMarker') : mappings;
}

/**
 * One page of `ListDurableExecutionsByFunction`, keeping `RUNNING` executions by ARN, each owned
 * through the stack that manages its function when that stack is recorded.
 *
 * @example
 * durableExecutionsPage({ DurableExecutions: [{ DurableExecutionArn: arn, Status: 'RUNNING' }] }, stackId);
 */
export function durableExecutionsPage(
  output: unknown,
  managedByStackId: string | undefined,
): Reading<Page<DiscoveredResource>> {
  const at = 'ListDurableExecutionsByFunction';
  const stack = managedByStackId === undefined ? {} : { managed_by_stack_id: managedByStackId };
  const executions = readEachEntry(output, 'DurableExecutions', at, (execution, where) => {
    const arn = requiredText(execution, 'DurableExecutionArn', where);
    if (!arn.ok) {
      return arn;
    }
    const status = requiredText(execution, 'Status', where);
    if (!status.ok) {
      return status;
    }
    const started = optionalInstant(execution, 'StartTimestamp', where);
    if (!started.ok) {
      return started;
    }
    const resource = untaggable(DURABLE_EXECUTION_RESOURCE_TYPE, arn.value, 'durable_executions');
    return ok(status.value === RUNNING ? [{ ...resource, ...createdAt(started.value), ...stack }] : []);
  });
  return executions.ok ? pageWithCursor(executions.value.flat(), output, at, 'NextMarker') : executions;
}

/**
 * The `Status` that `GetDurableExecution` reports.
 *
 * @example
 * durableStatusReading({ DurableExecutionArn: arn, Status: 'SUCCEEDED' }); // ok('SUCCEEDED')
 */
export function durableStatusReading(output: unknown): Reading<string> {
  return requiredText(output, 'Status', 'GetDurableExecution');
}

/**
 * The ARNs of one `ListDurableExecutionsByFunction` page's `RUNNING` executions.
 *
 * @example
 * runningExecutionArnsPage({ DurableExecutions: [{ DurableExecutionArn: arn, Status: 'RUNNING' }] }); // ok({ items: [arn] })
 */
export function runningExecutionArnsPage(output: unknown): Reading<Page<string>> {
  const page = durableExecutionsPage(output, undefined);
  return page.ok ? ok({ ...page.value, items: page.value.items.map((execution) => execution.identifier) }) : page;
}

function untaggable(
  resourceType: string,
  identifier: string,
  surface: LeakAuditSurface = 'functions',
): DiscoveredResource {
  return sighting(resourceType, identifier, surface, { kind: 'untaggable' });
}
