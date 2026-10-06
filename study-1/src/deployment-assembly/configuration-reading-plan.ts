// What provisioning must read after `cdk deploy`, decided from the frozen assembly alone (design
// §9.8 D4; BR-RUA-040, BR-RUA-050, BR-RUA-053; addendum §2.4). Pure: it reads bytes and listings
// it is given and never calls AWS.
// - The stack tags `cdk deploy` applies are the ones the frozen cloud-assembly manifest declares
//   (`artifacts.<stack>.properties.tags`, proven on a real synthesis by admission's
//   `ownership-strategy.integration.test.ts`); the resource manifest records them.
// - The frozen template decides the reads: the provider's published version (runtime,
//   architectures, memory, timeout, environment variable names, version), every event-source
//   mapping (settings and state), every queue (FIFO, deduplication, visibility, redrive), every
//   table (stream specification, billing mode), and the provisioned concurrency of every published
//   version and alias. Lambda configures provisioned concurrency only on a version or an alias,
//   never on `$LATEST` (https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html),
//   so reading every version and alias the stack declares covers every function.
// - A planned read is resolved to the physical id CloudFormation listed for its logical id.
//   UNVERIFIED (cloud phase): the physical id forms below are the ones CloudFormation documents as
//   the `Ref` value of each type (version and alias ARN, mapping UUID, queue URL, table name); a
//   real deployment confirms them, and a mismatch reads as an unresolved target, never a guess.
// - The answers become configuration readings for `checkConfiguration`. A failed read, a
//   provisioned-concurrency configuration that exists (addendum §2.4: none anywhere) and a version
//   that differs from the one asked for are reasons, so provisioning cannot be `succeeded` on them.

import { boundedJsonText, describeJson, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { JsonValue, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { KeyValueEntry, StackResourceEntry } from '../record-contract/records/group-a/resource_manifest.ts';
import { ownField } from '../trial-message/trial-message-fields.ts';
import { deploymentReason } from './deployment-reasons.ts';
import { providerVersionLogicalId, readExecutionTemplate } from './execution-template.ts';
import type { AttributeReading, PostDeployReadFailure } from './post-deploy-reading.ts';
import { FUNCTION_VERSION_ATTRIBUTE, PROVISIONED_CONCURRENCY_ATTRIBUTE } from './post-deploy-reading.ts';
import type { ConfigurationReading } from './provisioning-readings.ts';

export type PlannedReadKind =
  'function_configuration' | 'event_source_mapping' | 'provisioned_concurrency' | 'queue' | 'table';

/** One read the frozen template asks for, by the logical id it is recorded under. */
export interface PlannedRead {
  readonly kind: PlannedReadKind;
  readonly logical_id: string;
}

/** Every post-deploy read of one frozen template. */
export interface PostDeployReadPlan {
  /** The logical id of the provider's published version (BR-RUA-053). */
  readonly provider_version_logical_id: string;
  /** Sorted by logical id, then kind. */
  readonly reads: readonly PlannedRead[];
}

/** A planned read resolved to the identifiers its AWS request names. */
export type ReadRequest =
  | {
      readonly kind: 'function_configuration' | 'provisioned_concurrency';
      readonly logical_id: string;
      readonly function_name: string;
      readonly qualifier: string;
    }
  | { readonly kind: 'event_source_mapping'; readonly logical_id: string; readonly uuid: string }
  | { readonly kind: 'queue'; readonly logical_id: string; readonly queue_url: string }
  | { readonly kind: 'table'; readonly logical_id: string; readonly table_name: string };

/** One executed read: the request and what the reader answered. */
export interface ReadOutcome {
  readonly request: ReadRequest;
  readonly answer: Result<readonly AttributeReading[], PostDeployReadFailure>;
}

/** The requests that could be resolved, and a reason for every planned read that could not. */
export interface ResolvedReads {
  readonly requests: readonly ReadRequest[];
  readonly reasons: readonly StructuredReason[];
}

/** The configuration readings of every answered read, and a reason for every problem found. */
export interface ConfigurationSnapshot {
  readonly readings: readonly ConfigurationReading[];
  readonly reasons: readonly StructuredReason[];
}

const KIND_BY_TYPE: Readonly<Record<string, PlannedReadKind>> = {
  'AWS::Lambda::EventSourceMapping': 'event_source_mapping',
  'AWS::Lambda::Version': 'provisioned_concurrency',
  'AWS::Lambda::Alias': 'provisioned_concurrency',
  'AWS::SQS::Queue': 'queue',
  'AWS::DynamoDB::Table': 'table',
};
const QUALIFIED_ARN = /^arn:aws:lambda:[a-z0-9-]+:[0-9]{12}:function:([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,128})$/;
const MAPPING_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUEUE_URL = /^https:\/\/\S+\/[0-9]{12}\/[A-Za-z0-9_-]{1,80}(\.fifo)?$/;
const TABLE_NAME = /^[A-Za-z0-9_.-]{3,255}$/;
const ASSEMBLY_MANIFEST = 'manifest.json';

/**
 * The tags the frozen cloud-assembly manifest declares for `stackName`, sorted by key, or the
 * reason it declares none that can be read.
 *
 * @example
 * declaredStackTags(manifestBytes, 'SucRua-run-3f1c2a9e'); // { ok: true, value: [{ key: 'suc:expires_at', ... }, ...] }
 */
export function declaredStackTags(
  manifestBytes: Uint8Array,
  stackName: string,
): Result<KeyValueEntry[], StructuredReason> {
  const parsed = parseJsonDocument(manifestBytes);
  const tags = parsed.ok
    ? ['artifacts', stackName, 'properties', 'tags'].reduce<JsonValue | undefined>(
        (value, name) => (isJsonObject(value) ? ownField(value, name) : undefined),
        parsed.value,
      )
    : undefined;
  const entries = isJsonObject(tags) ? Object.entries(tags) : [];
  const strings = entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  if (!isJsonObject(tags) || strings.length !== entries.length) {
    return err(
      deploymentReason(
        'DECLARED_TAGS_UNREADABLE',
        'BR-RUA-050',
        `${ASSEMBLY_MANIFEST} declares stack tags ${describeJson(tags)}; expected artifacts.${boundedJsonText(stackName)}.properties.tags as an object of string values`,
      ),
    );
  }
  return ok(strings.map(([key, value]) => ({ key, value })).toSorted((a, b) => (a.key < b.key ? -1 : 1)));
}

/**
 * The reads a frozen template asks for, or the reason the template cannot be planned from.
 *
 * @example
 * const plan = planPostDeployReads(templateBytes);
 * if (plan.ok) plan.value.reads; // [{ kind: 'table', logical_id: 'CallerJournalTable' }, ...]
 */
export function planPostDeployReads(templateBytes: Uint8Array): Result<PostDeployReadPlan, StructuredReason> {
  const template = readExecutionTemplate(templateBytes);
  if (!template.ok) {
    return template;
  }
  const providerVersion = providerVersionLogicalId(template.value);
  if (!providerVersion.ok) {
    return providerVersion;
  }
  const typed = [...template.value.byLogicalId.values()].flatMap((resource) => {
    const kind = Object.hasOwn(KIND_BY_TYPE, resource.type) ? KIND_BY_TYPE[resource.type] : undefined;
    return kind === undefined ? [] : [{ kind, logical_id: resource.logical_id }];
  });
  const reads = [{ kind: 'function_configuration' as const, logical_id: providerVersion.value }, ...typed];
  return ok({ provider_version_logical_id: providerVersion.value, reads: reads.toSorted(compareReads) });
}

/**
 * The planned reads resolved against the listed stack resources: each needs a listed resource of
 * its logical id whose physical id has the form its request names.
 *
 * @example
 * resolveReadRequests(plan.reads, manifestResources); // { requests: [{ kind: 'queue', logical_id, queue_url }], reasons: [] }
 */
export function resolveReadRequests(
  reads: readonly PlannedRead[],
  resources: readonly StackResourceEntry[],
): ResolvedReads {
  const listed = new Map(resources.map((resource) => [resource.logical_id, resource.physical_id]));
  const requests: ReadRequest[] = [];
  const reasons: StructuredReason[] = [];
  for (const read of reads) {
    const physicalId = listed.get(read.logical_id);
    const request = physicalId === undefined ? undefined : requestFor(read, physicalId);
    if (request === undefined) {
      reasons.push(unresolved(read, listed.has(read.logical_id), physicalId));
      continue;
    }
    requests.push(request);
  }
  return { requests, reasons };
}

/**
 * The configuration readings of every answered read, recorded under the read's logical id, with a
 * reason for every failed read, existing provisioned concurrency and mismatched version.
 *
 * @example
 * configurationSnapshotOf(outcomes); // { readings: [{ logical_id: 'ConventionalMapping', attribute_path: 'State', value: 'Enabled' }, ...], reasons: [] }
 */
export function configurationSnapshotOf(outcomes: readonly ReadOutcome[]): ConfigurationSnapshot {
  const readings: ConfigurationReading[] = [];
  const reasons: StructuredReason[] = [];
  for (const { request, answer } of outcomes) {
    if (!answer.ok) {
      reasons.push(readFailed(request, answer.error));
      continue;
    }
    readings.push(...answer.value.map((reading) => ({ logical_id: request.logical_id, ...reading })));
    reasons.push(...answer.value.flatMap((reading) => readingProblems(request, reading)));
  }
  return { readings, reasons };
}

function compareReads(a: PlannedRead, b: PlannedRead): number {
  const left = `${a.logical_id}\u0000${a.kind}`;
  const right = `${b.logical_id}\u0000${b.kind}`;
  return left < right ? -1 : 1;
}

function requestFor(read: PlannedRead, physicalId: string): ReadRequest | undefined {
  switch (read.kind) {
    case 'function_configuration':
    case 'provisioned_concurrency':
      return qualifiedRequest(read.kind, read.logical_id, physicalId);
    case 'event_source_mapping':
      return MAPPING_UUID.test(physicalId)
        ? { kind: read.kind, logical_id: read.logical_id, uuid: physicalId }
        : undefined;
    case 'queue':
      return QUEUE_URL.test(physicalId)
        ? { kind: read.kind, logical_id: read.logical_id, queue_url: physicalId }
        : undefined;
    case 'table':
      return TABLE_NAME.test(physicalId)
        ? { kind: read.kind, logical_id: read.logical_id, table_name: physicalId }
        : undefined;
  }
}

function qualifiedRequest(
  kind: 'function_configuration' | 'provisioned_concurrency',
  logicalId: string,
  physicalId: string,
): ReadRequest | undefined {
  const match = QUALIFIED_ARN.exec(physicalId);
  const [, functionName, qualifier] = match ?? [];
  if (functionName === undefined || qualifier === undefined) {
    return undefined;
  }
  return { kind, logical_id: logicalId, function_name: functionName, qualifier };
}

function readingProblems(request: ReadRequest, reading: AttributeReading): readonly StructuredReason[] {
  if (reading.attribute_path === PROVISIONED_CONCURRENCY_ATTRIBUTE && reading.value !== null) {
    return [
      deploymentReason(
        'PROVISIONED_CONCURRENCY_PRESENT',
        'BR-RUA-053',
        `${request.logical_id} has provisioned concurrency ${boundedJsonText(reading.value)}; expected none on any function (addendum §2.4)`,
      ),
    ];
  }
  const asked = request.kind === 'function_configuration' ? request.qualifier : undefined;
  if (reading.attribute_path !== FUNCTION_VERSION_ATTRIBUTE || asked === undefined || reading.value === asked) {
    return [];
  }
  return [
    deploymentReason(
      'PROVIDER_VERSION_MISMATCH',
      'BR-RUA-053',
      `${request.logical_id} reports version ${boundedJsonText(reading.value)}; expected the listed version ${asked}`,
    ),
  ];
}

function unresolved(read: PlannedRead, listed: boolean, physicalId: string | undefined): StructuredReason {
  const found = listed ? `physical id ${boundedJsonText(physicalId ?? null)}` : 'not listed';
  return deploymentReason(
    'READ_TARGET_UNRESOLVED',
    'BR-RUA-040',
    `${read.kind} read of ${read.logical_id} is ${found}; expected a listed resource whose physical id names the ${read.kind} target`,
  );
}

function readFailed(request: ReadRequest, failure: PostDeployReadFailure): StructuredReason {
  return deploymentReason(
    'CONFIGURATION_READ_FAILED',
    'BR-RUA-040',
    `${request.kind} read of ${request.logical_id} failed with ${failure.code}: ${failure.detail}; expected its post-deploy configuration`,
  );
}
