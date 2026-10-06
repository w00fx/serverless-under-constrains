// The ProbeRunner binding (design §10.2 P4 and P5 for the probe; BR-RUA-027, BR-RUA-044): the
// runner hands the probe workload to the real `ProbeWorkloadExecutor` (trial-execution) with the
// coordination checkpoint port of this execution, which the executor calls between building the
// transport probe result and writing the probe evidence index. The executor binds its checkpoint
// at construction, and the runner's checkpointer belongs to one execution, so each probe gets its
// own executor over the same collection, telemetry, warm-up and Invoke ports.

import { ProbeWorkloadExecutor } from '../trial-execution/probe-workload-executor.ts';
import type {
  CoordinationCheckpointWriter,
  ProbeExecutionReport,
  ProbeWorkloadExecutorDeps,
  ProbeWorkloadPlan,
  PublicationGate,
} from '../trial-execution/trial-execution-ports.ts';
import type { ProbeRunner } from './execution-ports.ts';

/** Everything the executor needs except the checkpoint, which the runner supplies per probe. */
export type ProbeRunnerDeps = Omit<ProbeWorkloadExecutorDeps, 'checkpoint'>;

/**
 * Runs each probe through a `ProbeWorkloadExecutor` bound to the runner's checkpoint.
 *
 * @example
 * const probe = new ExecutorProbeRunner({ store, telemetry, warmup, workload, files, runner_journal,
 *   clock, sleeper, ids, validator, log });
 * new ExecutionRunner(admitted, { ...deps, probe });
 */
export class ExecutorProbeRunner implements ProbeRunner {
  readonly #deps: ProbeRunnerDeps;

  constructor(deps: ProbeRunnerDeps) {
    this.#deps = deps;
  }

  execute(
    plan: ProbeWorkloadPlan,
    gate: PublicationGate,
    checkpoint: CoordinationCheckpointWriter,
  ): Promise<ProbeExecutionReport> {
    return new ProbeWorkloadExecutor({ ...this.#deps, checkpoint }).execute(plan, gate);
  }
}
