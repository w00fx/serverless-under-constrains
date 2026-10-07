// Conformance of the interrupting probe caller with the `ProbeWorkloadInvoker` contract: it answers
// exactly what the probe caller it wraps answers, and the hook runs once per Invoke, after it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProbeWorkloadRequest } from '../../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type {
  ProbeWorkloadInvokeResult,
  ProbeWorkloadInvoker,
} from '../../../../src/trial-execution/trial-execution-ports.ts';
import { InterruptingProbeCaller } from './interrupting-probe-caller.ts';

const ANSWER: ProbeWorkloadInvokeResult = { kind: 'rejected', code: 'TooManyRequestsException', detail: 'throttled' };

class RecordingProbeCaller implements ProbeWorkloadInvoker {
  readonly order: string[];

  constructor(order: string[]) {
    this.order = order;
  }

  invokeWorkload(_request: ProbeWorkloadRequest): Promise<ProbeWorkloadInvokeResult> {
    this.order.push('invoke');
    return Promise.resolve(ANSWER);
  }
}

describe('InterruptingProbeCaller', () => {
  it('answers what the inner caller answers and runs the hook after each Invoke', async () => {
    const order: string[] = [];
    const caller = new InterruptingProbeCaller(new RecordingProbeCaller(order), () => order.push('hook'));
    const request = {} as ProbeWorkloadRequest;
    assert.deepEqual(await caller.invokeWorkload(request), ANSWER);
    assert.deepEqual(await caller.invokeWorkload(request), ANSWER);
    assert.deepEqual(order, ['invoke', 'hook', 'invoke', 'hook']);
    assert.equal(caller.invocations(), 2);
  });
});
