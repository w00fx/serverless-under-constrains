// The probe caller's Invoke with a hook at the moment it returns: the probe was invoked, so an
// abort or a lost lease raised there lands after P4 started and before the probe settled, which is
// when the real probe executor must still freeze the evidence and report the interruption.

import type { ProbeWorkloadRequest } from '../../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type {
  ProbeWorkloadInvokeResult,
  ProbeWorkloadInvoker,
} from '../../../../src/trial-execution/trial-execution-ports.ts';

/**
 * Delegates every Invoke, then runs the hook once its answer is in.
 *
 * @example
 * const caller = new InterruptingProbeCaller(cloud.caller, () => runner.abort('SIGINT'));
 * await caller.invokeWorkload(request); // the inner answer; the hook has run
 */
export class InterruptingProbeCaller implements ProbeWorkloadInvoker {
  readonly #inner: ProbeWorkloadInvoker;
  readonly #afterInvoke: () => void;
  #invocations = 0;

  constructor(inner: ProbeWorkloadInvoker, afterInvoke: () => void) {
    this.#inner = inner;
    this.#afterInvoke = afterInvoke;
  }

  /** How many Invokes were delegated. */
  invocations(): number {
    return this.#invocations;
  }

  async invokeWorkload(request: ProbeWorkloadRequest): Promise<ProbeWorkloadInvokeResult> {
    this.#invocations += 1;
    const answer = await this.#inner.invokeWorkload(request);
    this.#afterInvoke();
    return answer;
  }
}
