// Steps 5 and 6 (BR-RUA-048 "releases held barriers and terminates active executions where
// necessary", then "records cleanup-induced transitions separately"; design §10.4, RK-10).
//
// Step 5 sends a conditional safety-release request to every treatment partition and stops
// every RUNNING durable execution of the run's durable functions. It runs before stack
// deletion: a running durable execution blocks stack deletion for up to an hour (RK-10).
// Step 6 then records each transition step 5 caused as `cleanup_induced: true`, so evidence
// never mistakes a cleanup release for the experiment's own (BR-RUA-025 safety release cause).

import type { StructuredReason } from '../record-contract/primitives.ts';
import type { CleanupFold } from './cleanup-action-fold.ts';
import type { BarrierReleasePort, DurableExecutionPort } from './cleanup-ports.ts';
import { ITEM_ACTIONS } from './cleanup-steps.ts';
import {
  DURABLE_EXECUTION_RESOURCE_TYPE,
  FUNCTION_RESOURCE_TYPE,
  TREATMENT_ITEM_RESOURCE_TYPE,
} from './resource-types.ts';
import type { ItemRecorder, StepOutcome } from './step-recording.ts';
import { outcomeFromFailures } from './step-recording.ts';

export interface QuiescingTargets {
  /** Control-table partitions that may hold a treatment barrier. */
  readonly treatment_partitions: readonly string[];
  /** Functions whose RUNNING durable executions must stop. */
  readonly durable_function_names: readonly string[];
}

export interface QuiescingPorts {
  readonly barriers: BarrierReleasePort;
  readonly durableExecutions: DurableExecutionPort;
}

/**
 * Step 5: releases held barriers and stops running durable executions.
 *
 * @example
 * await releaseBarriersAndStopExecutions({ treatment_partitions: [pk], durable_function_names: [fn] }, ports, record);
 */
export async function releaseBarriersAndStopExecutions(
  targets: QuiescingTargets,
  ports: QuiescingPorts,
  record: ItemRecorder,
): Promise<StepOutcome> {
  const failures: StructuredReason[] = [];
  for (const partition of targets.treatment_partitions) {
    failures.push(...(await releaseBarrier(partition, ports.barriers, record)));
  }
  for (const functionName of targets.durable_function_names) {
    failures.push(...(await stopRunningExecutions(functionName, ports.durableExecutions, record)));
  }
  return outcomeFromFailures(failures);
}

/**
 * Step 6: records every transition step 5 applied, in any run, that is not recorded yet.
 *
 * @example
 * await recordInducedTransitions(foldCleanupActions(entries), record); // one TREATMENT_SAFETY_RELEASED per release
 */
export async function recordInducedTransitions(fold: CleanupFold, record: ItemRecorder): Promise<StepOutcome> {
  for (const partition of fold.applied_releases.filter((key) => !fold.recorded_safety_releases.has(key))) {
    await record({
      action: ITEM_ACTIONS.treatmentSafetyReleased,
      resource_type: TREATMENT_ITEM_RESOURCE_TYPE,
      resource_identifier: partition,
      cleanup_induced: true,
    });
  }
  for (const arn of fold.stopped_durable_execution_arns.filter((key) => !fold.recorded_execution_stops.has(key))) {
    await record({
      action: ITEM_ACTIONS.durableExecutionStopped,
      resource_type: DURABLE_EXECUTION_RESOURCE_TYPE,
      resource_identifier: arn,
      cleanup_induced: true,
    });
  }
  return outcomeFromFailures([]);
}

async function releaseBarrier(
  partition: string,
  port: BarrierReleasePort,
  record: ItemRecorder,
): Promise<readonly StructuredReason[]> {
  const outcome = await port.requestSafetyRelease(partition);
  const named = { resource_type: TREATMENT_ITEM_RESOURCE_TYPE, resource_identifier: partition };
  switch (outcome.kind) {
    case 'released':
      await record({ ...named, action: ITEM_ACTIONS.safetyReleaseApplied });
      return [];
    case 'not_held':
      await record({ ...named, action: ITEM_ACTIONS.safetyReleaseNotHeld });
      return [];
    case 'failed':
      await record({ ...named, action: ITEM_ACTIONS.safetyReleaseFailed, reasons: [outcome.reason] });
      return [outcome.reason];
  }
}

async function stopRunningExecutions(
  functionName: string,
  port: DurableExecutionPort,
  record: ItemRecorder,
): Promise<readonly StructuredReason[]> {
  const listing = await port.listRunning(functionName);
  if (!listing.ok) {
    await record({
      action: ITEM_ACTIONS.durableListFailed,
      resource_type: FUNCTION_RESOURCE_TYPE,
      resource_identifier: functionName,
      reasons: [listing.reason],
    });
    return [listing.reason];
  }
  const failures: StructuredReason[] = [];
  for (const arn of listing.running_execution_arns) {
    const reason = await stopExecution(arn, port, record);
    failures.push(...reason);
  }
  return failures;
}

async function stopExecution(
  arn: string,
  port: DurableExecutionPort,
  record: ItemRecorder,
): Promise<readonly StructuredReason[]> {
  const outcome = await port.stop(arn);
  const named = { resource_type: DURABLE_EXECUTION_RESOURCE_TYPE, resource_identifier: arn };
  switch (outcome.kind) {
    case 'stopped':
      await record({ ...named, action: ITEM_ACTIONS.durableStopApplied });
      return [];
    case 'not_running':
      await record({ ...named, action: ITEM_ACTIONS.durableStopNotRunning });
      return [];
    case 'failed':
      await record({ ...named, action: ITEM_ACTIONS.durableStopFailed, reasons: [outcome.reason] });
      return [outcome.reason];
  }
}
