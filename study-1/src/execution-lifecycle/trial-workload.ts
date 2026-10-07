// P4 of a run or a variant validation (design §10.2; BR-RUA-019, BR-RUA-028, BR-RUA-045): every
// declared trial in declared order, each behind the publication gate. A trial whose start the gate
// refuses is never handed over, and an interruption ends the phase: no trial starts after it.

import type { StructuredReason } from '../record-contract/primitives.ts';
import type { Sleeper } from '../record-contract/primitives.ts';
import type { TrialExecutionReport, TrialFrozen, TrialInterruption } from '../trial-execution/trial-execution-ports.ts';
import type { ExecutionGate } from './execution-gate.ts';
import type { AdmittedTrialExecution, TrialRunner } from './execution-ports.ts';
import type { ExecutionWorkload, WorkloadContext, WorkloadOutcome } from './execution-workload.ts';
import { planDeclaredTrials } from './trial-plans.ts';

/** How often the runner re-reads an uncertain lease before handing over the next unit. */
export const LEASE_RECOVERY_POLL_MS = 5_000;

/**
 * The declared trials of one run or variant validation.
 *
 * @example
 * const outcome = await new TrialWorkload(admitted, trials).run(context);
 * outcome.trials.map((report) => report.kind); // ['frozen', 'frozen', 'frozen', 'frozen']
 */
export class TrialWorkload implements ExecutionWorkload {
  readonly #admitted: AdmittedTrialExecution;
  readonly #trials: TrialRunner;

  constructor(admitted: AdmittedTrialExecution, trials: TrialRunner) {
    this.#admitted = admitted;
    this.#trials = trials;
  }

  async run(context: WorkloadContext): Promise<WorkloadOutcome> {
    const { journal } = context;
    await journal.phase('TRIALS', 'started');
    const plans = planDeclaredTrials({
      admitted: this.#admitted,
      resource_manifest_sha256: context.resource_manifest_sha256,
      targets: context.targets,
    });
    if (!plans.ok) {
      await journal.phase('TRIALS', 'failed', [plans.error]);
      return { completed: false, trials: [], reasons: [plans.error] };
    }
    const reports: TrialExecutionReport[] = [];
    for (const plan of plans.value) {
      if (!(await awaitUnitStart(context.gate, context.services.sleeper))) {
        break;
      }
      const report = await this.#trials.execute(plan, context.gate);
      reports.push(report);
      if (report.kind === 'frozen' && report.interruption !== undefined) {
        context.unitRecordedInterruption();
      }
    }
    const interruption = await context.noteInterruption();
    if (interruption !== undefined) {
      await journal.phase('TRIALS', 'failed', [interruptionReason(interruption)]);
      return { completed: false, trials: reports, reasons: [] };
    }
    const unfrozen = reports.filter(
      (report): report is Exclude<TrialExecutionReport, TrialFrozen> => report.kind !== 'frozen',
    );
    await journal.phase(
      'TRIALS',
      unfrozen.length === 0 ? 'succeeded' : 'failed',
      unfrozen.flatMap((report) => report.reasons),
    );
    return { completed: true, trials: reports, reasons: [] };
  }
}

/**
 * BR-RUA-045: lease uncertainty blocks new publication without ending the execution, and a
 * recovery before staleness may resume scheduling. Handing a unit over while the lease is
 * uncertain would consume it (its setup runs, then T5 refuses to publish), so the runner waits
 * until the heartbeat confirms the lease again or loses it at the 300 s stale boundary (the loss
 * latches the gate); the active-time deadline bounds the wait as well. False when no unit may start.
 *
 * @example
 * if (await awaitUnitStart(gate, sleeper)) await trials.execute(plan, gate);
 */
export async function awaitUnitStart(gate: ExecutionGate, sleeper: Sleeper): Promise<boolean> {
  while (gate.mayStartTrial() && !gate.publicationAllowed()) {
    await sleeper.sleep(LEASE_RECOVERY_POLL_MS);
  }
  return gate.mayStartTrial();
}

/**
 * The reason an interruption leaves on the phase it ended.
 *
 * @example
 * interruptionReason({ cause: 'OPERATOR_ABORT', detail: 'SIGINT' }).code; // 'EXECUTION_INTERRUPTED'
 */
export function interruptionReason(interruption: TrialInterruption): StructuredReason {
  return {
    code: 'EXECUTION_INTERRUPTED',
    subject: 'BR-RUA-046',
    detail: `${interruption.cause}: ${interruption.detail}; expected no interruption before closure`,
  };
}
