// Shared fixtures of the late-record capture tests (BR-RUA-043, AC-RUA-030). One run whose trial,
// probe and execution-level partitions hold catalogue-valid events (the group-B contract examples,
// so the late-evidence reader accepts what is carried), frozen the way the runner freezes them: the
// frozen artifacts are the exact bytes the production collectors produced at freeze, before the
// late records were written to the same surfaces.

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import type { CaptureScope, CaptureUnit } from '../../../src/evidence-collection/capture-scope.ts';
import { capturePartitionKey, executionPartitionKey } from '../../../src/evidence-collection/capture-scope.ts';
import type { DurableListingRequest } from '../../../src/evidence-collection/durable-metadata.ts';
import type {
  FrozenArtifacts,
  LateCapturePlan,
  LateCapturePorts,
  LateCaptureUnit,
} from '../../../src/evidence-collection/late-record-capture.ts';
import { collectExecutionEvidence } from '../../../src/evidence-collection/readiness-collection.ts';
import { collectTrialEvidence } from '../../../src/evidence-collection/trial-collection.ts';
import type { CollectedFile } from '../../../src/evidence-collection/collection-buffer.ts';
import type { ExecutionIdentity, JsonObject, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { StudyRecord } from '../../../src/record-contract/records/index.ts';
import type { InMemoryItemStore } from '../durable-store/in-memory-item-store.ts';
import { storeHarness } from '../durable-store/item-store-fixtures.ts';
import type { VirtualTimeScheduler } from '../kernel/virtual-time-scheduler.ts';
import {
  EXECUTION_MANIFEST_SHA256,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
  toJson,
} from '../record-contract/record-builders.ts';
import { collectionClock, DURABLE_FUNCTION_ARN } from './collection-fixtures.ts';
import { ScriptedDlqReceiver } from './scripted-dlq-receiver.ts';
import { ScriptedDurableExecutionReader } from './scripted-durable-execution-reader.ts';
import { ScriptedTelemetryProbe } from './scripted-telemetry-probe.ts';

export const LATE_EXECUTION: ExecutionIdentity = { execution_kind: 'RUN', run_id: RUN_ID };
export const LATE_TRIAL_UNIT: CaptureUnit = {
  kind: 'trial',
  trial_id: TRIAL_ID,
  trial_manifest_sha256: TRIAL_MANIFEST_SHA256,
};
export const LATE_TRIAL_SCOPE: CaptureScope = {
  execution: LATE_EXECUTION,
  execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
  unit: LATE_TRIAL_UNIT,
};
export const LATE_TRIAL_PK = capturePartitionKey(LATE_TRIAL_SCOPE);
export const LATE_DLQ = {
  queue_url: 'https://sqs.us-east-1.amazonaws.com/012345678901/suc1-00000000-durable-dlq.fifo',
  queue_name: 'suc1-00000000-durable-dlq.fifo',
};
export const LATE_DURABLE: DurableListingRequest = {
  function_arn: DURABLE_FUNCTION_ARN,
  qualifier: '3',
  started_after: '2026-10-05T12:05:00.000Z' as UtcMillis,
};

/** The live surfaces a late capture re-reads, and the ports over them. */
export interface LateCaptureSurfaces {
  readonly store: InMemoryItemStore;
  readonly dlq: ScriptedDlqReceiver;
  readonly durable: ScriptedDurableExecutionReader;
  readonly clock: VirtualTimeScheduler;
  readonly ports: LateCapturePorts;
}

/**
 * Fresh surfaces: an in-memory store with pages of two items, a DLQ and a Durable listing.
 *
 * @example
 * const surfaces = lateCaptureSurfaces();
 * surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 1));
 */
export function lateCaptureSurfaces(): LateCaptureSurfaces {
  const { store } = storeHarness(2);
  const dlq = new ScriptedDlqReceiver();
  const durable = new ScriptedDurableExecutionReader();
  const clock = collectionClock();
  return { store, dlq, durable, clock, ports: { store, dlq, durable, clock } };
}

/**
 * The store item that holds a journal event: the event under `<source>#<instance>#<sequence:12>`
 * of the partition (design §9.3).
 *
 * @example
 * store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, timeoutSignalRecorded()));
 */
export function eventItem(pk: string, event: StudyRecord | JsonObject): StoredItem {
  const record = toJson(event as StudyRecord);
  const position = record as { source: string; source_instance_id: string; source_sequence: number };
  const sequence = String(position.source_sequence).padStart(12, '0');
  const sortKey = `${position.source}#${position.source_instance_id}#${sequence}`;
  return { ...record, pk, sk: sortKey };
}

/**
 * The event without its trial pair: the shape of an execution-level event (A-09 `#provider`).
 *
 * @example
 * executionLevel(providerCallRejected()); // no trial_id, no trial_manifest_sha256
 */
export function executionLevel(event: StudyRecord): JsonObject {
  const { trial_id: _trial, trial_manifest_sha256: _digest, ...rest } = toJson(event);
  return rest;
}

/**
 * Freezes one unit as the runner does at T8-T10: the production collector reads the surfaces and
 * its files become the unit's frozen artifacts.
 *
 * @example
 * const unit = await freezeUnit(surfaces, { unit: LATE_TRIAL_UNIT, dlq: LATE_DLQ });
 */
export async function freezeUnit(
  surfaces: LateCaptureSurfaces,
  unit: Omit<LateCaptureUnit, 'frozen'>,
  execution: ExecutionIdentity = LATE_EXECUTION,
): Promise<LateCaptureUnit> {
  const collection = await collectTrialEvidence(
    { ...surfaces.ports, telemetry: new ScriptedTelemetryProbe() },
    {
      scope: { execution, execution_manifest_sha256: EXECUTION_MANIFEST_SHA256, unit: unit.unit },
      ...(unit.dlq === undefined ? {} : { dlq: unit.dlq }),
      ...(unit.durable === undefined ? {} : { durable: unit.durable }),
    },
  );
  return { ...unit, frozen: frozenArtifactsOf(collection.files) };
}

/**
 * The frozen artifacts a collection's files make, keyed by layout name.
 *
 * @example
 * frozenArtifactsOf(collection.files).ledgerSnapshot; // the frozen ledger bytes
 */
export function frozenArtifactsOf(files: readonly CollectedFile[]): FrozenArtifacts {
  const frozen: Record<string, Uint8Array> = {};
  for (const file of files) {
    frozen[file.key] = file.bytes;
  }
  return frozen;
}

/**
 * Freezes every unit and the execution-level partitions into a capture plan.
 *
 * @example
 * const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT }]);
 */
export async function freezePlan(
  surfaces: LateCaptureSurfaces,
  units: readonly Omit<LateCaptureUnit, 'frozen'>[],
  execution: ExecutionIdentity = LATE_EXECUTION,
): Promise<LateCapturePlan> {
  const frozenUnits: LateCaptureUnit[] = [];
  for (const unit of units) {
    frozenUnits.push(await freezeUnit(surfaces, unit, execution));
  }
  return {
    execution,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    units: frozenUnits,
    execution_frozen: frozenArtifactsOf(
      (await collectExecutionEvidence(surfaces.store, execution, EXECUTION_MANIFEST_SHA256)).files,
    ),
  };
}

/**
 * The partition key of an execution-level partition of the fixture run.
 *
 * @example
 * lateExecutionPk('provider'); // `${RUN_ID}#provider`
 */
export function lateExecutionPk(
  kind: 'canary' | 'warmup' | 'provider',
  execution: ExecutionIdentity = LATE_EXECUTION,
): string {
  return executionPartitionKey(execution, EXECUTION_MANIFEST_SHA256, kind);
}
