// A trial runner that publishes nothing: it records each plan it was handed, lets the test act
// at that moment (abort, lose the lease), and answers a trial that did not start or whose freeze
// failed. The real `TrialExecutor` over the offline cloud is used wherever a trial's evidence is
// the subject; this fake isolates the runner's handling of what a trial reports.

import type {
  PublicationGate,
  TrialExecutionReport,
  TrialPlan,
} from '../../../../src/trial-execution/trial-execution-ports.ts';
import type { TrialRunner } from '../../../../src/execution-lifecycle/execution-ports.ts';

/** What every trial reports. */
export type ScriptedTrialAnswer = 'not_started' | 'freeze_failed';

/**
 * Answers every trial with the scripted report, after the optional hook ran.
 *
 * @example
 * const trials = new ScriptedTrialRunner('not_started', (sequence) => { if (sequence === 2) runner.abort('SIGINT'); });
 */
export class ScriptedTrialRunner implements TrialRunner {
  readonly #answer: ScriptedTrialAnswer;
  readonly #during: (sequence: number) => void;
  readonly #plans: TrialPlan[] = [];

  constructor(answer: ScriptedTrialAnswer = 'not_started', during: (sequence: number) => void = () => undefined) {
    this.#answer = answer;
    this.#during = during;
  }

  /** The plans handed over, in call order. */
  plans(): readonly TrialPlan[] {
    return [...this.#plans];
  }

  execute(plan: TrialPlan, gate: PublicationGate): Promise<TrialExecutionReport> {
    this.#plans.push(plan);
    this.#during(plan.trial.sequence);
    const allowed = gate.publicationAllowed();
    return Promise.resolve({
      kind: this.#answer,
      trial_id: plan.trial.trial_id,
      reasons: [
        {
          code: this.#answer === 'not_started' ? 'TRIAL_NOT_STARTED' : 'TRIAL_FREEZE_FAILED',
          subject: 'BR-RUA-019',
          detail: `scripted ${this.#answer} (publication ${allowed ? 'allowed' : 'refused'}); expected a frozen trial`,
        },
      ],
    });
  }
}
