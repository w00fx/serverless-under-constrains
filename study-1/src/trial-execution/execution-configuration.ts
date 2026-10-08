// The execution configuration item (Owner amendment A-09, decision 58): the control item
// `<execution_id>#execution` / `config` holding a `provider_execution_configuration` record. The
// provider reads it to journal calls that name no configured trial into `<execution_id>#provider`
// (AC-RUA-042). Trial execution writes it once at execution start and confirms it before every
// trial: its absence is a pre-publication setup rejection, because a call the provider could not
// attribute would then leave no evidence.

import type { DurableItemStore, StoredItem } from '../durable-store/item-store-port.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { ProviderExecutionConfiguration } from '../record-contract/records/group-a/provider_execution_configuration.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import {
  CONFIG_SORT_KEY,
  decodeExecutionConfigItem,
  executionConfigPartition,
} from '../refund-provider/control-items.ts';
import type { ExecutionIdentity, WallClock } from '../record-contract/primitives.ts';

const SUBJECT = 'A-09';

/** What the item names: the execution and its frozen manifest digest. */
export interface ExecutionConfigurationInput {
  readonly execution: ExecutionIdentity;
  readonly execution_manifest_sha256: Sha256Hex;
}

/**
 * The `provider_execution_configuration` record of an execution, written at `clock.now()`.
 *
 * @example
 * executionConfigurationRecord({ execution, execution_manifest_sha256 }, clock).execution_kind; // 'RUN'
 */
export function executionConfigurationRecord(
  input: ExecutionConfigurationInput,
  clock: WallClock,
): ProviderExecutionConfiguration {
  return {
    schema_version: 1,
    record_type: 'provider_execution_configuration',
    execution_kind: input.execution.execution_kind,
    ...executionIdentityFields(input.execution),
    execution_manifest_sha256: input.execution_manifest_sha256,
    written_at: formatUtcMillis(clock.now()),
  } as ProviderExecutionConfiguration;
}

/**
 * Writes the execution configuration item once (conditional on its absence). Refused with the
 * reason when the store did not apply it.
 *
 * @example
 * const written = await writeExecutionConfiguration(store, { execution, execution_manifest_sha256 }, clock);
 * if (!written.ok) rejectExecution(written.error);
 */
export async function writeExecutionConfiguration(
  store: DurableItemStore,
  input: ExecutionConfigurationInput,
  clock: WallClock,
): Promise<Result<void, StructuredReason>> {
  const item: StoredItem = {
    ...executionConfigurationRecord(input, clock),
    pk: executionConfigPartition(input.execution),
    sk: CONFIG_SORT_KEY,
  };
  const outcome = await store.write({ kind: 'put', table: 'control', item, condition: { kind: 'item_absent' } });
  if (outcome.kind === 'applied') {
    return ok(undefined);
  }
  return err({
    code: 'EXECUTION_CONFIGURATION_NOT_WRITTEN',
    subject: SUBJECT,
    detail: `control item ${item.pk}/${item.sk} write was ${outcome.kind}; expected it applied once at execution start`,
  });
}

/**
 * Confirms, with a consistent read, that the execution configuration item exists and names this
 * execution and manifest digest; otherwise the reason, which rejects the trial before publication.
 *
 * @example
 * const missing = await confirmExecutionConfiguration(store, { execution, execution_manifest_sha256 });
 * if (missing !== undefined) return notStarted([missing]);
 */
export async function confirmExecutionConfiguration(
  store: DurableItemStore,
  input: ExecutionConfigurationInput,
): Promise<StructuredReason | undefined> {
  const key = { pk: executionConfigPartition(input.execution), sk: CONFIG_SORT_KEY };
  const read = await store.getConsistent('control', key);
  if (!read.ok) {
    return rejection(`reading control item ${key.pk}/${key.sk} failed with ${read.error.code}`);
  }
  if (read.value === undefined) {
    return rejection(`control item ${key.pk}/${key.sk} is absent`);
  }
  const decoded = decodeExecutionConfigItem(read.value, input.execution);
  if (!decoded.ok) {
    return rejection(decoded.error);
  }
  if (decoded.value.execution_manifest_sha256 !== input.execution_manifest_sha256) {
    return rejection(
      `control item ${key.pk}/${key.sk} names manifest ${decoded.value.execution_manifest_sha256}, not ${input.execution_manifest_sha256}`,
    );
  }
  return undefined;
}

function rejection(problem: string): StructuredReason {
  return {
    code: 'EXECUTION_CONFIGURATION_MISSING',
    subject: SUBJECT,
    detail: `${problem}; expected the provider_execution_configuration of this execution before any trial`,
  };
}
