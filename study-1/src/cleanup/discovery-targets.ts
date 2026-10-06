// Everything cleanup's AWS adapters are bound to, derived from the frozen resource manifest and
// the execution identity (design §9.7, §9.14; BR-RUA-050, BR-RUA-051). The runner and
// `rua recover` both bind the adapters through it, so a recovery audits exactly what the original
// cleanup audited:
// - the recorded stack id (by name when provisioning never recorded one);
// - the physical ids CloudFormation recorded, by type: function names, mapping UUIDs, queue
//   URLs (and the queue ARNs that mappings name as their source), table and role names;
// - the deterministic names of design §9.7: the queue-name prefix, the log-group prefix and the
//   five table names, which find what a partial manifest never recorded;
// - the DLQ URLs and the Durable caller function from the stack outputs, with the version
//   qualifiers its executions run under.

import {
  logGroupNamePrefix,
  resourceNamePrefix,
  RUN_OWNED_TABLE_ROLES,
  tableName,
} from '../../infra/ownership/resource-naming.ts';
import { executionIdOf } from '../event-journal/journal-scope.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionIdentity, Result, StructuredReason, Uuid4 } from '../record-contract/primitives.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import { STUDY_ID_TAG } from './ownership-context.ts';
import {
  EVENT_SOURCE_MAPPING_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  FUNCTION_VERSION_RESOURCE_TYPE,
  QUEUE_RESOURCE_TYPE,
  ROLE_RESOURCE_TYPE,
  TABLE_RESOURCE_TYPE,
} from './resource-types.ts';
import { qualifiedFunctionParts } from './surface-readings-lambda.ts';

/**
 * The execution stack's DLQ outputs (`infra/stacks/execution-stack.ts` `EXECUTION_STACK_OUTPUTS`;
 * `src` may not import the stack, so a unit test pins these spellings to it).
 */
export const DLQ_OUTPUT_KEYS = ['ConventionalDeadLetterQueueUrl', 'DurableDeadLetterQueueUrl'] as const;
/** The execution stack's output naming the Durable caller function. */
export const DURABLE_FUNCTION_OUTPUT_KEY = 'DurableCallerFunctionName';

// https://sqs.<region>.amazonaws.com/<account>/<name>, the URL CloudFormation records for a queue.
const QUEUE_URL = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/([0-9]{12})\/([^/]+)$/;

/** A Durable function and the version qualifiers its executions run under. */
export interface DurableFunctionTarget {
  readonly function_name: string;
  readonly qualifiers: readonly string[];
}

/** What one execution's cleanup adapters query, describe and delete. */
export interface DiscoveryTargets {
  readonly execution_id: Uuid4;
  /** The `suc:study_id` value the tag-index filter matches. */
  readonly study_id: string;
  /** What the stack APIs are asked about: the recorded stack id, else the stack name. */
  readonly stack_ref: string;
  readonly recorded_stack_id?: string;
  readonly function_names: readonly string[];
  readonly durable_functions: readonly DurableFunctionTarget[];
  readonly event_source_mapping_ids: readonly string[];
  /** The ARNs of the recorded queues: mappings that consume them are listed by source. */
  readonly event_source_arns: readonly string[];
  readonly queue_names: readonly string[];
  readonly queue_name_prefix: string;
  readonly dlq_urls: readonly string[];
  readonly table_names: readonly string[];
  readonly log_group_prefix: string;
  readonly role_names: readonly string[];
}

export interface DiscoveryTargetsInput {
  readonly manifest: ResourceManifest;
  readonly execution: ExecutionIdentity;
}

type IdentityKey = 'run_id' | 'transport_probe_id' | 'variant_validation_id';
type IdentityCarrier = Readonly<Partial<Record<IdentityKey, string>>>;
const IDENTITY_KEYS: readonly IdentityKey[] = ['run_id', 'transport_probe_id', 'variant_validation_id'];

interface RecordedQueue {
  readonly name: string;
  readonly arn: string;
}

/**
 * The discovery targets of one execution, or why its manifest cannot bind the adapters: it
 * belongs to another execution, its `suc:study_id` tag is not exactly one, or a recorded queue
 * URL or DLQ output is not an SQS queue URL.
 *
 * @example
 * const targets = discoveryTargetsOf({ manifest, execution });
 * if (targets.ok) targets.value.queue_name_prefix; // 'suc1-3f1c2a9e-'
 */
export function discoveryTargetsOf(input: DiscoveryTargetsInput): Result<DiscoveryTargets, StructuredReason> {
  const { manifest, execution } = input;
  const mismatch = identityMismatch(manifest, execution);
  if (mismatch !== undefined) {
    return err(targetsReason(mismatch));
  }
  const studyTags = manifest.ownership_tags.filter((tag) => tag.key === STUDY_ID_TAG);
  const [studyTag] = studyTags;
  if (studyTag === undefined || studyTags.length !== 1) {
    return err(targetsReason(`${String(studyTags.length)} ${STUDY_ID_TAG} tags; expected exactly one`));
  }
  const queues = recordedQueues(physicalIds(manifest, QUEUE_RESOURCE_TYPE));
  if (!queues.ok) {
    return queues;
  }
  const outputs = new Map(manifest.outputs.map((output) => [output.key, output.value]));
  const dlqUrls = DLQ_OUTPUT_KEYS.flatMap((key) => [outputs.get(key) ?? []].flat());
  const unreadable = dlqUrls.find((url) => !QUEUE_URL.test(url));
  if (unreadable !== undefined) {
    return err(queueUrlReason('DLQ output', unreadable));
  }
  const executionId = executionIdOf(execution);
  return ok({
    execution_id: executionId,
    study_id: studyTag.value,
    stack_ref: manifest.stack_id ?? manifest.stack_name,
    ...(manifest.stack_id === undefined ? {} : { recorded_stack_id: manifest.stack_id }),
    function_names: physicalIds(manifest, FUNCTION_RESOURCE_TYPE),
    durable_functions: durableFunctions(manifest, outputs.get(DURABLE_FUNCTION_OUTPUT_KEY)),
    event_source_mapping_ids: physicalIds(manifest, EVENT_SOURCE_MAPPING_RESOURCE_TYPE),
    event_source_arns: queues.value.map((queue) => queue.arn),
    queue_names: queues.value.map((queue) => queue.name),
    queue_name_prefix: resourceNamePrefix(executionId),
    dlq_urls: dlqUrls,
    table_names: unique([
      ...physicalIds(manifest, TABLE_RESOURCE_TYPE),
      ...RUN_OWNED_TABLE_ROLES.map((role) => tableName(executionId, role)),
    ]),
    log_group_prefix: logGroupNamePrefix(executionId),
    role_names: physicalIds(manifest, ROLE_RESOURCE_TYPE),
  });
}

// Why the manifest is not this execution's: it must carry exactly this execution's one id field
// (D-06) and neither of the other two.
function identityMismatch(manifest: ResourceManifest, execution: ExecutionIdentity): string | undefined {
  const recorded: IdentityCarrier = manifest;
  const expected: IdentityCarrier = executionIdentityFields(execution);
  const field = IDENTITY_KEYS.find((key) => recorded[key] !== expected[key]);
  if (field === undefined) {
    return undefined;
  }
  return `resource manifest ${field} ${boundedJsonText(String(recorded[field]))}; expected ${String(expected[field])}`;
}

function physicalIds(manifest: ResourceManifest, resourceType: string): readonly string[] {
  return unique(
    manifest.resources.flatMap((entry) =>
      entry.resource_type === resourceType && entry.physical_id !== undefined ? [entry.physical_id] : [],
    ),
  );
}

function recordedQueues(urls: readonly string[]): Result<readonly RecordedQueue[], StructuredReason> {
  const queues: RecordedQueue[] = [];
  for (const url of urls) {
    const [, region, account, name] = QUEUE_URL.exec(url) ?? [];
    if (region === undefined || account === undefined || name === undefined) {
      return err(queueUrlReason('recorded queue', url));
    }
    queues.push({ name, arn: `arn:aws:sqs:${region}:${account}:${name}` });
  }
  return ok(queues);
}

// The Durable caller named by the stack output, with every recorded version of it as a qualifier:
// its executions run under the version its alias points at, and an unqualified listing covers
// only `$LATEST` (client-lambda 3.1146.0 `ListDurableExecutionsByFunctionRequest.Qualifier`).
function durableFunctions(manifest: ResourceManifest, functionName: string | undefined): DurableFunctionTarget[] {
  if (functionName === undefined) {
    return [];
  }
  const qualifiers = physicalIds(manifest, FUNCTION_VERSION_RESOURCE_TYPE).flatMap((arn) => {
    const parts = qualifiedFunctionParts(arn);
    return parts?.function_name === functionName ? [parts.qualifier] : [];
  });
  return [{ function_name: functionName, qualifiers }];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function queueUrlReason(what: string, url: string): StructuredReason {
  return targetsReason(
    `${what} ${boundedJsonText(url)}; expected an SQS queue URL https://sqs.<region>.amazonaws.com/<12-digit account>/<name>`,
  );
}

function targetsReason(detail: string): StructuredReason {
  return { code: 'DISCOVERY_TARGETS_UNRESOLVED', subject: 'BR-RUA-050', detail };
}
