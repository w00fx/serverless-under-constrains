// Offline stand-in for the runner's synchronous Invoke of the probe caller's published version
// (design §9.4 probe-caller row, §5.3 `ProbeWorkloadInvoker`; BR-RUA-027): the real ProbeCaller,
// composed exactly as its Lambda handler composes it (composeProbeCaller), runs in process against
// the offline provider. Its answer follows the Lambda Invoke API
// (https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html, "Error handling" of the Lambda
// developer guide): a returned report is StatusCode 200 with the report as Payload; an unhandled
// error is still StatusCode 200, with FunctionError `Unhandled` and the payload
// `{"errorType","errorMessage"}`. The request id is the invocation's `awsRequestId`, which the
// caller journals in `caller_invocation_started`, and it is answered as `$metadata.requestId`.
//
// Test hook: `scriptNext(result)` makes the next Invoke settle as given without running the caller.

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ProbeWorkloadRequest } from '../../../src/record-contract/records/group-a/probe_workload_request.ts';
import type { ProbeCaller } from '../../../src/transport-probe-caller/probe-caller.ts';
import type {
  ProbeWorkloadInvokeResult,
  ProbeWorkloadInvoker,
} from '../../../src/trial-execution/trial-execution-ports.ts';
import type { SequentialUuidSource } from '../kernel/sequential-uuid-source.ts';

export class OfflineProbeCaller implements ProbeWorkloadInvoker {
  readonly #caller: ProbeCaller;
  readonly #version: string;
  readonly #requestIds: SequentialUuidSource;
  readonly #requests: ProbeWorkloadRequest[] = [];
  #scripted: ProbeWorkloadInvokeResult | undefined;

  /** `version` is the published version the emulated Invoke reports as executed. */
  constructor(caller: ProbeCaller, version: string, requestIds: SequentialUuidSource) {
    this.#caller = caller;
    this.#version = version;
    this.#requestIds = requestIds;
  }

  async invokeWorkload(request: ProbeWorkloadRequest): Promise<ProbeWorkloadInvokeResult> {
    this.#requests.push(request);
    const scripted = this.#scripted;
    this.#scripted = undefined;
    if (scripted !== undefined) {
      return scripted;
    }
    const requestId = this.#requestIds.next();
    try {
      const report = await this.#caller.run({ payload: request as unknown as JsonValue, lambda_request_id: requestId });
      return this.#answer(requestId, report, undefined);
    } catch (error) {
      const thrown = error instanceof Error ? error : new Error(String(error));
      return this.#answer(requestId, { errorType: thrown.name, errorMessage: thrown.message }, 'Unhandled');
    }
  }

  /** The next Invoke settles as `result` without running the probe caller. */
  scriptNext(result: ProbeWorkloadInvokeResult): void {
    this.#scripted = result;
  }

  /** Every request the runner sent, in order. */
  requests(): readonly ProbeWorkloadRequest[] {
    return [...this.#requests];
  }

  #answer(requestId: string, body: object, functionError: string | undefined): ProbeWorkloadInvokeResult {
    return {
      kind: 'response',
      status_code: 200,
      executed_version: this.#version,
      ...(functionError === undefined ? {} : { function_error: functionError }),
      payload: new TextEncoder().encode(JSON.stringify(body)),
      request_id: requestId,
    };
  }
}
