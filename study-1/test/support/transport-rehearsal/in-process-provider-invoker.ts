// In-process emulator of the synchronous Lambda `Invoke` of the provider's published version
// (design §12.2, §9.4; the WP-08 transport rehearsal). It runs the real composed provider
// (`RefundProvider.handle`) in the same process and reproduces the documented behavior the
// provider client relies on (https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html):
// - the payload crosses the wire as JSON bytes, so the provider parses what the client sent;
// - a `RequestResponse` invocation returns StatusCode 200 and the `ExecutedVersion` of the
//   qualifier it was invoked with;
// - an error the handler throws is a function error: StatusCode 200, `FunctionError: Unhandled`
//   and the payload `{errorType, errorMessage}` (Lambda Node.js runtime error format);
// - aborting the client request does not stop the function: the client settles at once with the
//   `AbortError` the Lambda binding reports (`Request aborted`), while the provider keeps running
//   to completion. `whenIdle()` waits for every such in-flight provider execution.

import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ProviderRefundCall } from '../../../src/record-contract/records/group-a/provider_refund_call.ts';
import type {
  ProviderInvocationPort,
  ProviderTransportResult,
} from '../../../src/provider-client/provider-invocation-port.ts';
import type { ProviderInvocationResult } from '../../../src/refund-provider/refund-provider.ts';

/** The provider as the emulated Lambda runtime sees it: one JSON payload in, one result out. */
export interface InProcessProviderFunction {
  handle(payload: JsonValue): Promise<ProviderInvocationResult>;
}

/** What one provider execution did, recorded when it finished (after any client abort). */
export interface InProcessInvocation {
  readonly call: ProviderRefundCall;
  readonly aborted_by_client: boolean;
  readonly execution:
    | { readonly kind: 'returned'; readonly result: ProviderInvocationResult }
    | { readonly kind: 'threw'; readonly error_type: string };
}

/** The settlement an aborted in-flight request produces through the Lambda binding. */
export const IN_PROCESS_ABORTED: ProviderTransportResult = {
  kind: 'transport_error',
  error_name: 'AbortError',
  message: 'Request aborted',
};

export class InProcessProviderInvoker implements ProviderInvocationPort {
  readonly #provider: InProcessProviderFunction;
  readonly #qualifier: string;
  readonly #executions = new Set<Promise<void>>();
  readonly #finished: InProcessInvocation[] = [];

  /** `qualifier` is the published version the emulated function reports as executed. */
  constructor(provider: InProcessProviderFunction, qualifier: string) {
    this.#provider = provider;
    this.#qualifier = qualifier;
  }

  invoke(call: ProviderRefundCall, signal: AbortSignal): Promise<ProviderTransportResult> {
    const payload = JSON.parse(canonicalJson(call as unknown as JsonValue)) as JsonValue;
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve(IN_PROCESS_ABORTED);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const execution = this.#execute(call, payload, signal).then((settlement) => {
        signal.removeEventListener('abort', onAbort);
        resolve(settlement);
      });
      this.#track(execution);
    });
  }

  /** Waits until every provider execution, including those the client aborted, has finished. */
  async whenIdle(): Promise<void> {
    while (this.#executions.size > 0) {
      await Promise.all([...this.#executions]);
    }
  }

  /** The provider executions that finished, in completion order. */
  finished(): readonly InProcessInvocation[] {
    return [...this.#finished];
  }

  async #execute(call: ProviderRefundCall, payload: JsonValue, signal: AbortSignal): Promise<ProviderTransportResult> {
    try {
      const result = await this.#provider.handle(payload);
      this.#finished.push({ call, aborted_by_client: signal.aborted, execution: { kind: 'returned', result } });
      return this.#response(undefined, result as unknown as JsonValue);
    } catch (error) {
      const errorType = error instanceof Error ? error.name : 'NonErrorThrown';
      this.#finished.push({
        call,
        aborted_by_client: signal.aborted,
        execution: { kind: 'threw', error_type: errorType },
      });
      return this.#response('Unhandled', {
        errorType,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #response(functionError: string | undefined, body: JsonValue): ProviderTransportResult {
    return {
      kind: 'response',
      status_code: 200,
      executed_version: this.#qualifier,
      function_error: functionError,
      payload: new TextEncoder().encode(JSON.stringify(body)),
    };
  }

  #track(execution: Promise<void>): void {
    this.#executions.add(execution);
    void execution.finally(() => this.#executions.delete(execution));
  }
}
