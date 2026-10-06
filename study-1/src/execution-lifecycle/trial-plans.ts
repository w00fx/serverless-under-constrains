// The plans of the declared trials (design §10.2 P4; BR-RUA-019, BR-RUA-028, BR-RUA-040). Every
// plan is derived from the frozen execution manifest (identity, order, financial inputs, timing) and
// the frozen resource manifest (provider version, queues, Durable caller), so a trial can only run
// what admission and provisioning froze: the declared order is the manifest's array order, never
// recomputed, and the seed is recorded but derives nothing (BR-RUA-019).

import { err, ok } from '../record-contract/primitives.ts';
import type { Result, Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { DeclaredTrial, ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { TrialExecution, TrialPlan } from '../trial-execution/trial-execution-ports.ts';
import type { AdmittedExecution, AdmittedTrialExecution, ExecutionTargets } from './execution-ports.ts';

/** The frozen inputs the plans are derived from. */
export interface TrialPlanSources {
  readonly admitted: AdmittedTrialExecution;
  readonly resource_manifest_sha256: Sha256Hex;
  readonly targets: ExecutionTargets;
}

/**
 * The plans of every declared trial, in declared order, or the first reason one cannot be planned
 * (a trial whose variant the stack did not deploy cannot run).
 *
 * @example
 * const plans = planDeclaredTrials({ admitted, resource_manifest_sha256, targets });
 * if (plans.ok) plans.value.map((plan) => plan.trial.sequence); // [1, 2, 3, 4]
 */
export function planDeclaredTrials(sources: TrialPlanSources): Result<readonly TrialPlan[], StructuredReason> {
  const execution = sources.admitted.identity;
  const plans: TrialPlan[] = [];
  for (const trial of sources.admitted.manifest.trials) {
    const plan = planOf(sources, execution, trial);
    if (!plan.ok) {
      return plan;
    }
    plans.push(plan.value);
  }
  return ok(plans);
}

function planOf(
  sources: TrialPlanSources,
  execution: TrialExecution,
  trial: DeclaredTrial,
): Result<TrialPlan, StructuredReason> {
  const { manifest } = sources.admitted;
  const queues = sources.targets.queues[trial.variant_id];
  const caller = sources.targets.durable_caller;
  if (queues === undefined || (trial.variant_id === 'durable' && caller === undefined)) {
    return err({
      code: 'TRIAL_TARGETS_MISSING',
      subject: 'BR-RUA-040',
      detail: `trial ${String(trial.sequence)} (${trial.trial_id}) runs the ${trial.variant_id} variant, which the resource manifest does not deploy; expected its queues${trial.variant_id === 'durable' ? ' and Durable caller' : ''} among the stack outputs`,
    });
  }
  return ok({
    execution,
    execution_manifest_sha256: sources.admitted.manifest_sha256,
    resource_manifest_sha256: sources.resource_manifest_sha256,
    trial: {
      trial_id: trial.trial_id,
      sequence: trial.sequence,
      variant_id: trial.variant_id,
      scenario: trial.scenario,
    },
    ...financialRecords(manifest),
    provider_timing: {
      safety_release_ms: manifest.timing.provider_safety_release_ms,
      treatment_poll_interval_ms: manifest.timing.treatment_poll_interval_ms,
    },
    provider_version: sources.targets.provider_version,
    queues,
    ...(trial.variant_id === 'durable' && caller !== undefined ? { durable_caller: caller } : {}),
  });
}

// OR-RUA-001: the same payment and approved decision for every trial of the execution.
function financialRecords(manifest: ExecutionManifest): Pick<TrialPlan, 'payment' | 'approved_decision'> {
  const inputs = manifest.financial_inputs;
  return {
    payment: {
      schema_version: 1,
      record_type: 'payment',
      payment_id: inputs.payment_id,
      captured_amount_minor: inputs.captured_amount_minor,
      currency: inputs.currency,
    },
    approved_decision: {
      schema_version: 1,
      record_type: 'approved_decision',
      refund_request_id: inputs.refund_request_id,
      payment_id: inputs.payment_id,
      decision: inputs.decision,
      approved_amount_minor: inputs.approved_amount_minor,
      currency: inputs.currency,
    },
  };
}

/**
 * The admitted execution as one with trials; `undefined` for a probe, whose workload phases this
 * runner does not bind.
 *
 * @example
 * asTrialExecution(admitted)?.identity; // { execution_kind: 'RUN', run_id }
 */
export function asTrialExecution(admitted: AdmittedExecution): AdmittedTrialExecution | undefined {
  const { identity } = admitted;
  return identity.execution_kind === 'TRANSPORT_PROBE' ? undefined : { ...admitted, identity };
}
