// Treatment and configuration snapshots (design §5.3 "treatment and configuration snapshots", §7
// `state/`, §9.3 `control` and `trial-registry` items). Each is one strongly consistent point read
// of an item the runner, provider or controller wrote:
// - the `treatment` item becomes a `treatment_state_snapshot` (row 61) that says whether the item
//   exists, so a CONTROL trial records the absence the control-integrity gate needs (G4a);
// - the immutable trial `config` item is the `provider_trial_configuration` record (row 17);
// - the variant's `registry#<variant_id>`/`active` item is the `trial_registration` (row 18);
// - the execution-level `<execution_id>#execution`/`config` item is the
//   `provider_execution_configuration` record (Owner amendment A-09, decision 58).
// The configuration and registration records are copied as stored, without their table key: the
// collector records what the experiment ran under and leaves judging it to ingestion. A failed read
// or an absent configuration item yields no file, so ingestion reports the artifact missing.

import type { ItemKey, TableRole } from '../durable-store/item-store-port.ts';
import { executionIdOf } from '../event-journal/journal-scope.ts';
import { boundedText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type {
  ExecutionIdentity,
  JsonObject,
  Result,
  StructuredReason,
  VariantId,
  WallClock,
} from '../record-contract/primitives.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { capturePartitionKey, correlationFields } from './capture-scope.ts';
import type { CaptureScope } from './capture-scope.ts';
import { readFailure, recordOfItem } from './collected-records.ts';
import type { CollectorStoreReader } from './collected-records.ts';

/** Sort keys and partition spellings of the control and registry items (design §9.3, A-09). */
export const CONTROL_ITEM_KEYS = {
  configuration: 'config',
  treatment: 'treatment',
  executionPartitionSuffix: 'execution',
  registryActive: 'active',
  registryPartitionPrefix: 'registry#',
} as const;

/** The treatment snapshot and the item it read, for settlement and provider activity. */
export interface TreatmentCapture {
  /** The `treatment_state_snapshot` record. */
  readonly record: JsonObject;
  /** The treatment item without its key; absent when the partition holds none. */
  readonly treatment?: JsonObject;
}

/**
 * Reads the capture's `treatment` control item into a `treatment_state_snapshot`.
 *
 * @example
 * const snapshot = await captureTreatmentSnapshot(store, scope, clock);
 * if (snapshot.ok) snapshot.value.record['item_present']; // false for a CONTROL trial
 */
export async function captureTreatmentSnapshot(
  reader: CollectorStoreReader,
  scope: CaptureScope,
  clock: WallClock,
): Promise<Result<TreatmentCapture, StructuredReason>> {
  const partitionKey = capturePartitionKey(scope);
  const read = await readControlRecord(reader, 'control', { pk: partitionKey, sk: CONTROL_ITEM_KEYS.treatment });
  if (!read.ok) {
    return read;
  }
  const base = {
    schema_version: 1,
    record_type: 'treatment_state_snapshot',
    ...correlationFields(scope),
    partition_key: partitionKey,
    captured_at: formatUtcMillis(clock.now()),
    consistent_read: true,
  };
  if (read.value === undefined) {
    return ok({ record: { ...base, item_present: false } });
  }
  return ok({ record: { ...base, item_present: true, treatment: read.value }, treatment: read.value });
}

/**
 * Reads the capture's immutable `config` item: the `provider_trial_configuration` record.
 *
 * @example
 * const configuration = await captureProviderTrialConfiguration(store, scope);
 */
export async function captureProviderTrialConfiguration(
  reader: CollectorStoreReader,
  scope: CaptureScope,
): Promise<Result<JsonObject, StructuredReason>> {
  const key = { pk: capturePartitionKey(scope), sk: CONTROL_ITEM_KEYS.configuration };
  return requiredRecord(await readControlRecord(reader, 'control', key), 'control', key);
}

/**
 * Reads the variant's active registry item: the `trial_registration` record (D-21).
 *
 * @example
 * const registration = await captureTrialRegistration(store, 'conventional');
 */
export async function captureTrialRegistration(
  reader: CollectorStoreReader,
  variant: VariantId,
): Promise<Result<JsonObject, StructuredReason>> {
  const key = { pk: `${CONTROL_ITEM_KEYS.registryPartitionPrefix}${variant}`, sk: CONTROL_ITEM_KEYS.registryActive };
  return requiredRecord(await readControlRecord(reader, 'trial_registry', key), 'trial_registry', key);
}

/**
 * Reads the execution configuration item the runner writes at execution start (A-09).
 *
 * @example
 * const configuration = await captureExecutionConfiguration(store, { execution_kind: 'RUN', run_id });
 */
export async function captureExecutionConfiguration(
  reader: CollectorStoreReader,
  execution: ExecutionIdentity,
): Promise<Result<JsonObject, StructuredReason>> {
  const key = {
    pk: `${executionIdOf(execution)}#${CONTROL_ITEM_KEYS.executionPartitionSuffix}`,
    sk: CONTROL_ITEM_KEYS.configuration,
  };
  return requiredRecord(await readControlRecord(reader, 'control', key), 'control', key);
}

async function readControlRecord(
  reader: CollectorStoreReader,
  table: TableRole,
  key: ItemKey,
): Promise<Result<JsonObject | undefined, StructuredReason>> {
  const read = await reader.getConsistent(table, key);
  if (!read.ok) {
    return err(readFailure('STATE_READ_FAILED', table, `${key.pk}/${key.sk}`, read.error));
  }
  return ok(read.value === undefined ? undefined : recordOfItem(read.value));
}

function requiredRecord(
  read: Result<JsonObject | undefined, StructuredReason>,
  table: TableRole,
  key: ItemKey,
): Result<JsonObject, StructuredReason> {
  if (!read.ok) {
    return read;
  }
  if (read.value === undefined) {
    return err({
      code: 'STATE_ITEM_ABSENT',
      subject: 'BR-RUA-037',
      detail: `${table} item ${boundedText(`${key.pk}/${key.sk}`)} is absent; expected the item the runner writes before publication`,
    });
  }
  return ok(read.value);
}
