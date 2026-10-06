// What cleanup acts on (design §10.4; BR-RUA-048, BR-RUA-050): the ownership context built from the
// frozen resource manifest, the event-source mappings, every declared trial's treatment partition
// (a partition whose trial never armed answers `not_held`), the Durable caller functions, and the
// scope of the pre-cleanup snapshot. A deploy that did not complete names no targets; its mappings
// are the ones the partial resource manifest recorded, and ownership rule 4 covers the rest.

import type { CleanupHistory } from '../cleanup/cleanup-history.ts';
import type { CleanupInput } from '../cleanup/cleanup-orchestrator.ts';
import { ownershipContextFromManifest, STUDY_BASELINE_EXCLUSIONS } from '../cleanup/ownership-context.ts';
import type { PreCleanupPlan } from '../evidence-collection/pre-cleanup-snapshot.ts';
import { executionIdOf } from '../evidence-package/package-layout.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { AdmittedExecution, ExecutionTargets } from './execution-ports.ts';
import { recordedEventSourceMappings } from './execution-targets.ts';

/** Cleanup's input and the pre-cleanup snapshot's scope. */
export interface CleanupPlan {
  readonly input: CleanupInput;
  readonly snapshot: Omit<PreCleanupPlan, 'cleanup_mode'>;
}

/** What the plan is derived from. */
export interface CleanupPlanSources {
  readonly admitted: AdmittedExecution;
  readonly resource_manifest: ResourceManifest;
  /** Present when the deploy succeeded. */
  readonly targets: ExecutionTargets | undefined;
  readonly history: CleanupHistory;
  /** The first mutation's instant: Durable executions started after it belong to the execution. */
  readonly started_at: UtcMillis;
}

/**
 * Cleanup's plan for one execution, or the reason ownership cannot be established from the
 * resource manifest (then nothing may be deleted).
 *
 * @example
 * const plan = planCleanup({ admitted, resource_manifest, targets, history, started_at });
 * if (plan.ok) await orchestrator.runEmergency(plan.value.input);
 */
export function planCleanup(sources: CleanupPlanSources): Result<CleanupPlan, StructuredReason> {
  const { admitted, resource_manifest: manifest, targets } = sources;
  const ownership = ownershipContextFromManifest({
    manifest,
    execution: admitted.identity,
    execution_manifest_frozen_at: admitted.manifest.frozen_at,
    baseline: STUDY_BASELINE_EXCLUSIONS,
  });
  if (!ownership.ok) {
    return err(ownership.error);
  }
  const partitions = treatmentPartitions(admitted);
  const caller = targets?.durable_caller;
  return ok({
    input: {
      execution: admitted.identity,
      execution_manifest_sha256: admitted.manifest_sha256,
      ownership: ownership.value,
      targets: {
        event_source_mapping_ids: targets?.event_source_mapping_ids ?? recordedEventSourceMappings(manifest),
        treatment_partitions: partitions,
        durable_function_names: targets?.durable_function_names ?? [],
      },
      history: sources.history,
    },
    snapshot: {
      execution: admitted.identity,
      execution_manifest_sha256: admitted.manifest_sha256,
      partition_keys: partitions,
      durable_listings: caller === undefined ? [] : [{ ...caller, started_after: sources.started_at }],
      queues: Object.values(targets?.queues ?? {}).flatMap((queues) => [queues.source, queues.dlq]),
    },
  });
}

// `<execution_id>#<trial_id>` for every declared trial, or `<execution_id>#probe` (design §9.3).
function treatmentPartitions(admitted: AdmittedExecution): readonly string[] {
  const executionId = executionIdOf(admitted.identity);
  const units =
    admitted.identity.execution_kind === 'TRANSPORT_PROBE'
      ? ['probe']
      : admitted.manifest.trials.map((trial) => trial.trial_id);
  return units.map((unit) => `${executionId}#${unit}`);
}
