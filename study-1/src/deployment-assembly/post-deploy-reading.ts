// What provisioning reads back from AWS after `cdk deploy` (design §9.8 D4; BR-RUA-040, BR-RUA-053;
// addendum §2.4): the `PostDeployReader` port and the total mappers from the raw SDK outputs to the
// values the resource manifest records. The adapter in `aws/post-deploy-readers.ts` sends exactly one
// request per port call and hands the raw output here, so every decision about the answer stays in
// this module (design §5 principle 5, §15.4).
//
// The outputs are untrusted (A-05): a member may be absent, of the wrong type, inherited, a `Date`,
// non-finite or deeply nested. Each mapper reads own members only, never throws, and turns an answer
// that does not fit into a failure naming the member and the expected shape. A configuration
// attribute is recorded as what the API returned: an absent member is `null` (so absence is
// evidence, never silently equal), and any other member must be representable as JSON exactly.

import { nonEmptyString, ownValue, quoted } from '../evidence-collection/sdk-values.ts';
import { canonicalJsonIfRepresentable } from '../record-contract/canonical-json.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonValue, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { KeyValueEntry } from '../record-contract/records/group-a/resource_manifest.ts';
import { deploymentReason } from './deployment-reasons.ts';
import type { StackResourceSummary } from './provisioning-readings.ts';
import type { StackDescription } from './resource-manifest.ts';

/** Why one read failed: the service error's name and message, or why its answer was malformed. */
export interface PostDeployReadFailure {
  readonly code: string;
  readonly detail: string;
}

export type PostDeployRead<T> = Promise<Result<T, PostDeployReadFailure>>;

/** One attribute a read returned, under the path the resource manifest records it with. */
export interface AttributeReading {
  readonly attribute_path: string;
  readonly value: JsonValue;
}

/** One ListStackResources page; `next_token` is present while more pages follow. */
export interface StackResourcePage {
  readonly resources: readonly StackResourceSummary[];
  readonly next_token?: string;
}

/**
 * The post-deploy reads, one AWS request each. Only reads: no method mutates the account.
 */
export interface PostDeployReader {
  /** DescribeStacks; `undefined` when the stack does not exist. */
  describeStack(stackName: string): PostDeployRead<StackDescription | undefined>;
  /** One ListStackResources page of a stack, named by its id or name. */
  listStackResources(stack: string, nextToken?: string): PostDeployRead<StackResourcePage>;
  /** GetFunctionConfiguration of one published version. */
  readFunctionConfiguration(functionName: string, qualifier: string): PostDeployRead<readonly AttributeReading[]>;
  /** GetEventSourceMapping by UUID. */
  readEventSourceMapping(uuid: string): PostDeployRead<readonly AttributeReading[]>;
  /** GetProvisionedConcurrencyConfig of one version or alias; a missing config reads as `null`. */
  readProvisionedConcurrency(functionName: string, qualifier: string): PostDeployRead<readonly AttributeReading[]>;
  /** GetQueueAttributes (All) of one queue URL. */
  readQueueAttributes(queueUrl: string): PostDeployRead<readonly AttributeReading[]>;
  /** DescribeTable of one table name. */
  readTable(tableName: string): PostDeployRead<readonly AttributeReading[]>;
}

/** An attribute the manifest records and the member path it is read from in the SDK output. */
interface AttributeSource {
  readonly attribute_path: string;
  readonly member_path: readonly string[];
}

/** The attribute path of the provisioned-concurrency reading of a version or alias. */
export const PROVISIONED_CONCURRENCY_ATTRIBUTE = 'ProvisionedConcurrencyConfig';
/** The attribute path of the version number a function configuration reports. */
export const FUNCTION_VERSION_ATTRIBUTE = 'Version';
/** The attribute path of a function's sorted environment variable names (never their values). */
export const ENVIRONMENT_KEYS_ATTRIBUTE = 'EnvironmentKeys';
/** The Lambda error of a version or alias without provisioned concurrency. */
export const PROVISIONED_CONCURRENCY_NOT_FOUND = 'ProvisionedConcurrencyConfigNotFoundException';

/** The most ListStackResources pages read; CloudFormation caps a stack far below this many. */
export const MAX_RESOURCE_PAGES = 20;

const FUNCTION_SOURCES = sources(['Runtime', 'Architectures', 'MemorySize', 'Timeout', FUNCTION_VERSION_ATTRIBUTE]);
const MAPPING_SOURCES = sources([
  'State',
  'FunctionArn',
  'EventSourceArn',
  'BatchSize',
  'MaximumBatchingWindowInSeconds',
  'ScalingConfig',
  'ProvisionedPollerConfig',
  'FilterCriteria',
  'StartingPosition',
  'ParallelizationFactor',
  'MaximumRetryAttempts',
  'MaximumRecordAgeInSeconds',
  'BisectBatchOnFunctionError',
  'DestinationConfig',
]);
const CONCURRENCY_SOURCES = sources([
  'RequestedProvisionedConcurrentExecutions',
  'AllocatedProvisionedConcurrentExecutions',
  'AvailableProvisionedConcurrentExecutions',
  'Status',
]);
const QUEUE_SOURCES: readonly AttributeSource[] = [
  'FifoQueue',
  'ContentBasedDeduplication',
  'VisibilityTimeout',
  'RedrivePolicy',
].map((name) => ({ attribute_path: name, member_path: ['Attributes', name] }));
const TABLE_SOURCES: readonly AttributeSource[] = [
  { attribute_path: 'StreamSpecification', member_path: ['Table', 'StreamSpecification'] },
  { attribute_path: 'BillingModeSummary.BillingMode', member_path: ['Table', 'BillingModeSummary', 'BillingMode'] },
];

/**
 * The described stack of a DescribeStacks answer: exactly one stack with an id, a status and
 * string tags.
 *
 * @example
 * stackDescriptionOf({ Stacks: [{ StackId: arn, StackStatus: 'CREATE_COMPLETE', Tags: [] }] });
 * // { ok: true, value: { stack_id: arn, stack_status: 'CREATE_COMPLETE', tags: [] } }
 */
export function stackDescriptionOf(output: unknown): Result<StackDescription, PostDeployReadFailure> {
  const stacks = ownValue(output, 'Stacks');
  const [stack] = Array.isArray(stacks) ? (stacks as readonly unknown[]) : [];
  const stackId = nonEmptyString(ownValue(stack, 'StackId'));
  const status = nonEmptyString(ownValue(stack, 'StackStatus'));
  const tags = tagsOf(ownValue(stack, 'Tags'));
  if (!Array.isArray(stacks) || stacks.length !== 1 || stackId === undefined || status === undefined) {
    return err(
      malformed(
        'DescribeStacks',
        `Stacks ${quoted(stacks)}; expected exactly one stack with a StackId and a StackStatus`,
      ),
    );
  }
  if (tags === undefined) {
    return err(
      malformed('DescribeStacks', `Tags ${quoted(ownValue(stack, 'Tags'))}; expected a list of string Key/Value pairs`),
    );
  }
  return ok({ stack_id: stackId, stack_status: status, tags });
}

/**
 * Whether a DescribeStacks failure says the stack does not exist (CloudFormation answers
 * `ValidationError` "Stack with id <name> does not exist"), which is an answer, not a failed read.
 *
 * @example
 * isMissingStack({ code: 'ValidationError', detail: 'Stack with id SucRua-run-3f1c2a9e does not exist' }, 'SucRua-run-3f1c2a9e'); // true
 */
export function isMissingStack(failure: PostDeployReadFailure, stackName: string): boolean {
  return failure.code === 'ValidationError' && failure.detail.includes(`${stackName} does not exist`);
}

/**
 * One ListStackResources page: every summary with string logical id, type and status (the
 * physical id is optional), and the next token when one is given.
 *
 * @example
 * stackResourcePageOf({ StackResourceSummaries: [summary], NextToken: 't2' }); // { ok: true, value: { resources: [...], next_token: 't2' } }
 */
export function stackResourcePageOf(output: unknown): Result<StackResourcePage, PostDeployReadFailure> {
  const summaries = ownValue(output, 'StackResourceSummaries');
  const token = ownValue(output, 'NextToken');
  const listed = Array.isArray(summaries) ? (summaries as readonly unknown[]).map(resourceSummaryOf) : [undefined];
  const resources = listed.filter((summary) => summary !== undefined);
  const nextToken = nonEmptyString(token);
  if (resources.length !== listed.length || (token !== undefined && nextToken === undefined)) {
    return err(
      malformed(
        'ListStackResources',
        `StackResourceSummaries ${quoted(summaries)} and NextToken ${quoted(token)}; expected a list of summaries with string LogicalResourceId, ResourceType and ResourceStatus, and an absent or nonempty token`,
      ),
    );
  }
  return ok(nextToken === undefined ? { resources } : { resources, next_token: nextToken });
}

/**
 * The configuration of a published function version: runtime, architectures, memory, timeout,
 * version, and the sorted names of its environment variables.
 *
 * @example
 * functionConfigurationOf({ Runtime: 'nodejs24.x', Version: '7', Environment: { Variables: { B: '1', A: '2' } } });
 * // ok: [..., { attribute_path: 'EnvironmentKeys', value: ['A', 'B'] }]
 */
export function functionConfigurationOf(output: unknown): Result<readonly AttributeReading[], PostDeployReadFailure> {
  const read = attributesOf(output, FUNCTION_SOURCES, 'GetFunctionConfiguration');
  if (!read.ok) {
    return read;
  }
  const variables = ownValue(ownValue(output, 'Environment'), 'Variables');
  if (variables !== undefined && !isRecordObject(variables)) {
    return err(
      malformed('GetFunctionConfiguration', `Environment.Variables ${quoted(variables)}; expected an object or none`),
    );
  }
  const keys = variables === undefined ? [] : Object.keys(variables).toSorted();
  return ok([...read.value, { attribute_path: ENVIRONMENT_KEYS_ATTRIBUTE, value: keys }]);
}

/**
 * The settings and state of an event source mapping.
 *
 * @example
 * eventSourceMappingOf({ UUID: id, State: 'Enabled', BatchSize: 1 }); // ok: [{ attribute_path: 'State', value: 'Enabled' }, ...]
 */
export function eventSourceMappingOf(output: unknown): Result<readonly AttributeReading[], PostDeployReadFailure> {
  return attributesOf(output, MAPPING_SOURCES, 'GetEventSourceMapping');
}

/**
 * A provisioned-concurrency configuration that exists, as one attribute.
 *
 * @example
 * provisionedConcurrencyOf({ RequestedProvisionedConcurrentExecutions: 1, Status: 'READY' });
 * // ok: [{ attribute_path: 'ProvisionedConcurrencyConfig', value: { RequestedProvisionedConcurrentExecutions: 1, ..., Status: 'READY' } }]
 */
export function provisionedConcurrencyOf(output: unknown): Result<readonly AttributeReading[], PostDeployReadFailure> {
  const read = attributesOf(output, CONCURRENCY_SOURCES, 'GetProvisionedConcurrencyConfig');
  if (!read.ok) {
    return read;
  }
  const config = Object.fromEntries(read.value.map((reading) => [reading.attribute_path, reading.value]));
  return ok([{ attribute_path: PROVISIONED_CONCURRENCY_ATTRIBUTE, value: config }]);
}

/**
 * The reading of a version or alias that has no provisioned concurrency (addendum §2.4).
 *
 * @example
 * absentProvisionedConcurrency(); // [{ attribute_path: 'ProvisionedConcurrencyConfig', value: null }]
 */
export function absentProvisionedConcurrency(): readonly AttributeReading[] {
  return [{ attribute_path: PROVISIONED_CONCURRENCY_ATTRIBUTE, value: null }];
}

/**
 * The queue attributes the protocol depends on, as the strings SQS returns them.
 *
 * @example
 * queueAttributesOf({ Attributes: { FifoQueue: 'true', VisibilityTimeout: '60' } });
 * // ok: [{ attribute_path: 'FifoQueue', value: 'true' }, { attribute_path: 'ContentBasedDeduplication', value: null }, ...]
 */
export function queueAttributesOf(output: unknown): Result<readonly AttributeReading[], PostDeployReadFailure> {
  const read = attributesOf(output, QUEUE_SOURCES, 'GetQueueAttributes');
  const nonString = read.ok ? read.value.find((reading) => !isStringOrNull(reading.value)) : undefined;
  if (nonString === undefined) {
    return read;
  }
  return err(
    malformed('GetQueueAttributes', `${nonString.attribute_path} ${quoted(nonString.value)}; expected a string`),
  );
}

/**
 * A table's stream specification and billing mode.
 *
 * @example
 * tableDescriptionOf({ Table: { StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' } } });
 */
export function tableDescriptionOf(output: unknown): Result<readonly AttributeReading[], PostDeployReadFailure> {
  return attributesOf(output, TABLE_SOURCES, 'DescribeTable');
}

/**
 * Every resource of a stack, page after page, or the reason the listing is incomplete: a failed
 * page, a repeated token or more than `MAX_RESOURCE_PAGES` pages (a listing that never ends is
 * never taken for a complete one).
 *
 * @example
 * const listed = await listAllStackResources(reader, stackId);
 * if (listed.ok) listed.value.length; // every listed resource
 */
export async function listAllStackResources(
  reader: PostDeployReader,
  stack: string,
): Promise<Result<readonly StackResourceSummary[], StructuredReason>> {
  const resources: StackResourceSummary[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < MAX_RESOURCE_PAGES; page += 1) {
    const listed = await reader.listStackResources(stack, token);
    if (!listed.ok) {
      return err(stackReadReason('ListStackResources', stack, listed.error));
    }
    resources.push(...listed.value.resources);
    token = listed.value.next_token;
    if (token === undefined || tokens.has(token)) {
      return token === undefined
        ? ok(resources)
        : err(pagingReason(stack, `repeated NextToken ${boundedJsonText(token)}`));
    }
    tokens.add(token);
  }
  return err(pagingReason(stack, `more than ${String(MAX_RESOURCE_PAGES)} pages`));
}

/**
 * The reason a stack read failed.
 *
 * @example
 * stackReadReason('DescribeStacks', 'SucRua-run-3f1c2a9e', { code: 'Throttling', detail: 'Rate exceeded' }).code; // 'STACK_READ_FAILED'
 */
export function stackReadReason(operation: string, stack: string, failure: PostDeployReadFailure): StructuredReason {
  return deploymentReason(
    'STACK_READ_FAILED',
    'BR-RUA-040',
    `${operation} of ${boundedJsonText(stack)} failed with ${failure.code}: ${failure.detail}; expected the deployed stack's facts`,
  );
}

function sources(names: readonly string[]): readonly AttributeSource[] {
  return names.map((name) => ({ attribute_path: name, member_path: [name] }));
}

// Each listed member as JSON, `null` when absent; the first member JSON cannot represent exactly
// fails the whole answer.
function attributesOf(
  output: unknown,
  attributeSources: readonly AttributeSource[],
  operation: string,
): Result<readonly AttributeReading[], PostDeployReadFailure> {
  const readings: AttributeReading[] = [];
  for (const source of attributeSources) {
    const member = source.member_path.reduce<unknown>((holder, name) => ownValue(holder, name), output);
    const value = member === undefined ? null : jsonOf(member);
    if (value === undefined) {
      return err(
        malformed(operation, `${source.member_path.join('.')} ${quoted(member)}; expected a finite JSON value`),
      );
    }
    readings.push({ attribute_path: source.attribute_path, value });
  }
  return ok(readings);
}

// A detached JSON copy of a member, or `undefined` when JSON cannot represent it exactly.
function jsonOf(member: unknown): JsonValue | undefined {
  const text = canonicalJsonIfRepresentable(member);
  return text === undefined ? undefined : (JSON.parse(text) as JsonValue);
}

function resourceSummaryOf(summary: unknown): StackResourceSummary | undefined {
  const logicalId = ownValue(summary, 'LogicalResourceId');
  const type = ownValue(summary, 'ResourceType');
  const status = ownValue(summary, 'ResourceStatus');
  const physicalId = ownValue(summary, 'PhysicalResourceId');
  const typed = typeof logicalId === 'string' && typeof type === 'string' && typeof status === 'string';
  if (!typed || (physicalId !== undefined && typeof physicalId !== 'string')) {
    return undefined;
  }
  return {
    logical_id: logicalId,
    resource_type: type,
    ...(physicalId === undefined ? {} : { physical_id: physicalId }),
    resource_status: status,
  };
}

function tagsOf(tags: unknown): KeyValueEntry[] | undefined {
  if (tags === undefined) {
    return [];
  }
  if (!Array.isArray(tags)) {
    return undefined;
  }
  const entries = (tags as readonly unknown[]).map((tag) => ({
    key: ownValue(tag, 'Key'),
    value: ownValue(tag, 'Value'),
  }));
  const typed = entries.filter(
    (entry): entry is KeyValueEntry => typeof entry.key === 'string' && typeof entry.value === 'string',
  );
  return typed.length === entries.length ? typed : undefined;
}

function isRecordObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: JsonValue): boolean {
  return value === null || typeof value === 'string';
}

function malformed(operation: string, detail: string): PostDeployReadFailure {
  return { code: `${operation}OutputMalformed`, detail: boundedText(detail, 600) };
}

function pagingReason(stack: string, found: string): StructuredReason {
  return deploymentReason(
    'RESOURCE_LISTING_INCOMPLETE',
    'BR-RUA-040',
    `ListStackResources of ${boundedJsonText(stack)} returned ${found}; expected a final page within ${String(MAX_RESOURCE_PAGES)} pages`,
  );
}
