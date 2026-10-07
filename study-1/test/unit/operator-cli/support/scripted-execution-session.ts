// Named fake of one execution's runner as the execute commands drive it (design §10.2; production:
// `ExecutionRunner` built by `createAwsExecutionSessions`): every run method records which one was
// called and answers one scripted outcome; `abort` answers like the runner's gate (the first abort
// interrupts, every later one finds the execution already interrupted); `during` runs while the
// execution is in flight, for a test to interrupt it. Its conformance test
// (`execute-commands.integration.test.ts`) binds the commands to the real `ExecutionRunner` over the
// offline cloud and expects the same answers.

import type { AbortAnswer } from '../../../../src/execution-lifecycle/execution-gate.ts';
import type { ExecutionOutcome } from '../../../../src/execution-lifecycle/execution-ports.ts';
import type { ExecutionSession } from '../../../../src/operator-cli/execute-commands.ts';

export type SessionRun = 'runProbe' | 'runValidation' | 'runCanonical';

export class ScriptedExecutionSession implements ExecutionSession {
  readonly #outcome: ExecutionOutcome;
  readonly #during: () => void;
  /** Every run method called, in order. */
  readonly runs: SessionRun[] = [];
  /** Every abort detail, in order. */
  readonly aborts: string[] = [];

  constructor(outcome: ExecutionOutcome, during: () => void = () => undefined) {
    this.#outcome = outcome;
    this.#during = during;
  }

  runProbe(): Promise<ExecutionOutcome> {
    return this.#run('runProbe');
  }

  runValidation(): Promise<ExecutionOutcome> {
    return this.#run('runValidation');
  }

  runCanonical(): Promise<ExecutionOutcome> {
    return this.#run('runCanonical');
  }

  abort(detail: string): AbortAnswer {
    this.aborts.push(detail);
    return this.aborts.length === 1 ? 'interrupting' : 'already_interrupted';
  }

  #run(method: SessionRun): Promise<ExecutionOutcome> {
    this.runs.push(method);
    this.#during();
    return Promise.resolve(this.#outcome);
  }
}
