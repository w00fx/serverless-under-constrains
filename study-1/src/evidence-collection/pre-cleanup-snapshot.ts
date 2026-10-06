// The pre-cleanup snapshot (design §10.4 step 4, §7 `cleanup/pre-cleanup-snapshot.json`, catalogue
// row 64; BR-RUA-048). After consumers are disabled and before cleanup releases barriers, stops
// executions or deletes anything, the collector records the operational state cleanup is about to
// change: each partition's treatment state, its derived provider activity, every Durable execution
// and its status, and the queue counters. It is best effort in both modes: every read that fails is
// recorded in `failures` and in the entry's `unavailable` status, and the snapshot is still written,
// because a partial snapshot is the evidence of what could be seen.

import { pushEach } from '../durable-store/push-each.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  Sha256Hex,
  StructuredReason,
  WallClock,
} from '../record-contract/primitives.ts';
import { TREATMENT_STATES } from '../record-contract/records/group-b/vocabulary.ts';
import type { CleanupMode } from '../record-contract/records/group-b/vocabulary.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { readFailure, readWholePartition, recordOfItem } from './collected-records.ts';
import type { CollectorStoreReader } from './collected-records.ts';
import { listDurableExecutions } from './durable-metadata.ts';
import type { DurableExecutionReader, DurableListingRequest } from './durable-metadata.ts';
import { deriveProviderActivity } from './provider-activity.ts';
import { countersJson } from './queue-observation.ts';
import type { QueueCounterReader, QueueTarget } from './queue-observation.ts';
import { CONTROL_ITEM_KEYS } from './state-capture.ts';
import { ownValue, quoted, safeCount } from './sdk-values.ts';

/** The ports the snapshot reads through. */
export interface PreCleanupPorts {
  readonly store: CollectorStoreReader;
  readonly queues: QueueCounterReader;
  readonly durable: DurableExecutionReader;
  readonly clock: WallClock;
}

/** What the snapshot covers: every partition the execution used, its Durable functions and queues. */
export interface PreCleanupPlan {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
  readonly cleanup_mode: CleanupMode;
  /** Trial and probe partitions (`<execution_id>#<trial_id>`, `<execution_id>#probe`). */
  readonly partition_keys: readonly string[];
  readonly durable_listings: readonly DurableListingRequest[];
  readonly queues: readonly QueueTarget[];
}

/** The snapshot record and every failure it records. */
export interface PreCleanupCapture {
  readonly record: JsonObject;
  readonly failures: readonly StructuredReason[];
}

const PROVIDER_SORT_KEY_PREFIX = 'refund_provider#';

interface PartitionState {
  readonly treatment: JsonObject;
  readonly activity?: JsonObject;
}

/**
 * Captures the `pre_cleanup_snapshot` record, best effort, before cleanup mutates anything.
 *
 * @example
 * const snapshot = await capturePreCleanupSnapshot(ports, plan);
 * snapshot.record['failures']; // [] when every read succeeded
 */
export async function capturePreCleanupSnapshot(
  ports: PreCleanupPorts,
  plan: PreCleanupPlan,
): Promise<PreCleanupCapture> {
  const failures: StructuredReason[] = [];
  const partitions: PartitionState[] = [];
  for (const partitionKey of plan.partition_keys) {
    partitions.push(await readPartitionState(ports.store, partitionKey, failures));
  }
  const durableExecutions: JsonObject[] = [];
  for (const request of plan.durable_listings) {
    const listing = await listDurableExecutions(ports.durable, request);
    pushEach(failures, listing.failures);
    for (const execution of listing.executions) {
      durableExecutions.push({ durable_execution_arn: execution.durable_execution_arn, status: execution.status });
    }
  }
  const queues: JsonObject[] = [];
  for (const target of plan.queues) {
    queues.push(await readQueue(ports.queues, target, failures));
  }
  const record: JsonObject = {
    schema_version: 1,
    record_type: 'pre_cleanup_snapshot',
    ...executionIdentityFields(plan.execution),
    execution_manifest_sha256: plan.execution_manifest_sha256,
    captured_at: formatUtcMillis(ports.clock.now()),
    cleanup_mode: plan.cleanup_mode,
    treatment_states: partitions.map((partition) => partition.treatment),
    provider_activity: partitions.flatMap((partition) =>
      partition.activity === undefined ? [] : [partition.activity],
    ),
    durable_executions: durableExecutions,
    queues,
    failures: failures.map((failure) => ({ ...failure })),
  };
  return { record, failures };
}

async function readPartitionState(
  store: CollectorStoreReader,
  partitionKey: string,
  failures: StructuredReason[],
): Promise<PartitionState> {
  const read = await store.getConsistent('control', { pk: partitionKey, sk: CONTROL_ITEM_KEYS.treatment });
  if (!read.ok) {
    failures.push(readFailure('STATE_READ_FAILED', 'control', `${partitionKey}/treatment`, read.error));
    return { treatment: { partition_key: partitionKey, read_status: 'unavailable' } };
  }
  const item = read.value === undefined ? undefined : recordOfItem(read.value);
  const treatment = treatmentEntry(partitionKey, item, failures);
  const journal = await readWholePartition(store, 'experiment_journal', partitionKey);
  if (!journal.ok) {
    failures.push(journal.error);
    return { treatment };
  }
  // Only the provider's own events count; the sort key names the source (design §9.3).
  const providerEvents = journal.value.items
    .filter((stored) => stored.sk.startsWith(PROVIDER_SORT_KEY_PREFIX))
    .map(recordOfItem);
  const activity = deriveProviderActivity(providerEvents, item);
  return { treatment, activity: { partition_key: partitionKey, ...activity } };
}

// A treatment item is reported by state and version only when both have the record's shape.
function treatmentEntry(partitionKey: string, item: JsonObject | undefined, failures: StructuredReason[]): JsonObject {
  if (item === undefined) {
    return { partition_key: partitionKey, read_status: 'absent' };
  }
  const state = TREATMENT_STATES.find((candidate) => candidate === ownValue(item, 'state'));
  const version = safeCount(ownValue(item, 'version'), 1);
  if (state === undefined || version === undefined) {
    failures.push({
      code: 'TREATMENT_ITEM_MALFORMED',
      subject: 'BR-RUA-048',
      detail: `treatment item of ${boundedText(partitionKey)} has state ${quoted(ownValue(item, 'state'))} and version ${quoted(ownValue(item, 'version'))}; expected a state in ${TREATMENT_STATES.join(', ')} and a version >= 1`,
    });
    return { partition_key: partitionKey, read_status: 'unavailable' };
  }
  return { partition_key: partitionKey, read_status: 'ok', state, version };
}

async function readQueue(
  reader: QueueCounterReader,
  target: QueueTarget,
  failures: StructuredReason[],
): Promise<JsonObject> {
  const read = await reader.read(target.queue_url);
  if (!read.ok) {
    failures.push(readFailure('QUEUE_READ_FAILED', 'sqs', target.queue_name, read.error));
    return { queue_name: target.queue_name, read_status: 'unavailable' };
  }
  return { queue_name: target.queue_name, read_status: 'ok', counters: countersJson(read.value) };
}
