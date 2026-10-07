// A probe runner that invokes nothing: it records each plan it was handed, lets the test act at
// that moment (abort, lose the lease), optionally asks the runner's checkpoint as the real P5 does,
// and answers a probe that did not start or whose freeze failed. The real `ProbeWorkloadExecutor`
// over the offline probe cloud is used wherever the probe's evidence is the subject; this fake
// isolates the runner's handling of what the probe reports.

import type { ProbeRunner } from '../../../../src/execution-lifecycle/execution-ports.ts';
import type { StructuredReason } from '../../../../src/record-contract/primitives.ts';
import type {
  CoordinationCheckpointWriter,
  ProbeExecutionReport,
  ProbeWorkloadPlan,
  PublicationGate,
} from '../../../../src/trial-execution/trial-execution-ports.ts';

/** What the probe reports: never started, or a freeze that failed after asking for the checkpoint. */
export type ScriptedProbeAnswer = 'not_started' | 'freeze_failed';

/**
 * Answers every probe with the scripted report, after the optional hook ran.
 *
 * @example
 * const probe = new ScriptedProbeRunner('freeze_failed', () => runner.abort('SIGINT'));
 */
export class ScriptedProbeRunner implements ProbeRunner {
  readonly #answer: ScriptedProbeAnswer;
  readonly #during: () => void;
  readonly #plans: ProbeWorkloadPlan[] = [];
  readonly #checkpoints: (StructuredReason | undefined)[] = [];

  constructor(answer: ScriptedProbeAnswer = 'not_started', during: () => void = () => undefined) {
    this.#answer = answer;
    this.#during = during;
  }

  /** The plans handed over, in call order. */
  plans(): readonly ProbeWorkloadPlan[] {
    return [...this.#plans];
  }

  /** What each checkpoint the fake asked for answered, in call order. */
  checkpoints(): readonly (StructuredReason | undefined)[] {
    return [...this.#checkpoints];
  }

  async execute(
    plan: ProbeWorkloadPlan,
    gate: PublicationGate,
    checkpoint: CoordinationCheckpointWriter,
  ): Promise<ProbeExecutionReport> {
    this.#plans.push(plan);
    this.#during();
    const allowed = gate.publicationAllowed();
    if (this.#answer === 'freeze_failed') {
      this.#checkpoints.push(await checkpoint.writeCheckpoint());
    }
    return {
      kind: this.#answer,
      transport_probe_id: plan.execution.transport_probe_id,
      reasons: [
        {
          code: this.#answer === 'not_started' ? 'PROBE_NOT_STARTED' : 'PROBE_FREEZE_FAILED',
          subject: 'BR-RUA-027',
          detail: `scripted ${this.#answer} (publication ${allowed ? 'allowed' : 'refused'}); expected a frozen probe`,
        },
      ],
    };
  }
}
