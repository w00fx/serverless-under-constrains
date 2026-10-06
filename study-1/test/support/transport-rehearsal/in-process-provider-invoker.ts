// In-process emulator of the synchronous Lambda `Invoke` of the provider's published version
// (design §12.2, §9.4; the WP-08 transport rehearsal). It runs the real composed provider
// (`RefundProvider.handle`) in the same process and reproduces the documented behavior the
// provider client relies on (https://docs.aws.amazon.com/lambda/latest/api/API_Invoke.html):
// - the payload crosses the wire as JSON bytes, so the provider parses what the client sent;
// - a `RequestResponse` invocation returns StatusCode 200 and the `ExecutedVersion` of the
//   qualifier it was invoked with;
// - an error the handler throws is a function error: StatusCode 200, `FunctionError: Unhandled`
//   and the payload the Node.js runtime interface client builds (`toRapidResponse` in
//   https://github.com/aws/aws-lambda-nodejs-runtime-interface-client/blob/main/src/Errors.js):
//   `{errorType: name, errorMessage: message, trace: stack lines}` for an Error,
//   `{errorType: typeof value, errorMessage: value.toString(), trace: []}` for any other value,
//   and `{errorType: 'handled', errorMessage: …}` when those members cannot be read;
// - aborting the client request does not stop the function: the client settles at once with the
//   `AbortError` the Lambda binding reports (`Request aborted`), while the provider keeps running
//   to completion. `whenIdle()` waits for every such in-flight provider execution.
// The runner's warm-up (addendum §2.1) crosses the same emulated Invoke through `invokeRequest`.

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

type ProviderExecution =
  | { readonly kind: 'returned'; readonly result: ProviderInvocationResult }
  | { readonly kind: 'threw'; readonly error_type: string };

/** What one provider execution did, recorded when it finished (after any client abort). */
export interface InProcessInvocation {
  readonly call: ProviderRefundCall;
  readonly aborted_by_client: boolean;
  readonly execution: ProviderExecution;
}

/** The settlement an aborted in-flight request produces through the Lambda binding. */
export const IN_PROCESS_ABORTED: ProviderTransportResult = {
  kind: 'transport_error',
  error_name: 'AbortError',
  message: 'Request aborted',
};

/** The error body the runtime returns with `FunctionError: Unhandled`. */
interface RuntimeErrorPayload {
  readonly errorType: string;
  readonly errorMessage: string;
  readonly trace?: readonly string[];
}

// The runtime's fallback when an error's members cannot be read (`toRapidResponse`).
const UNREADABLE_ERROR_PAYLOAD: RuntimeErrorPayload = {
  errorType: 'handled',
  errorMessage:
    'callback called with Error argument, but there was a problem while retrieving one or more of its message, name, and stack',
};

interface ExecutionOutcome {
  readonly execution: ProviderExecution;
  readonly settlement: ProviderTransportResult;
}

export class InProcessProviderInvoker implements ProviderInvocationPort {
  readonly #provider: InProcessProviderFunction;
  readonly #qualifier: string;
  readonly #executions = new Set<Promise<void>>();
  readonly #finished: InProcessInvocation[] = [];
  readonly #requests: JsonValue[] = [];

  /** `qualifier` is the published version the emulated function reports as executed. */
  constructor(provider: InProcessProviderFunction, qualifier: string) {
    this.#provider = provider;
    this.#qualifier = qualifier;
  }

  invoke(call: ProviderRefundCall, signal: AbortSignal): Promise<ProviderTransportResult> {
    const payload = overTheWire(call as unknown as JsonValue);
    return new Promise((resolve) => {
      const onAbort = (): void => {
        resolve(IN_PROCESS_ABORTED);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const execution = this.#execute(payload).then(({ execution: done, settlement }) => {
        this.#finished.push({ call, aborted_by_client: signal.aborted, execution: done });
        signal.removeEventListener('abort', onAbort);
        resolve(settlement);
      });
      this.#track(execution);
    });
  }

  /**
   * One synchronous Invoke with any JSON request and no client abort: the runner's warm-up
   * (addendum §2.1). It is not a refund call, so it is listed by `requests()`, not `finished()`.
   *
   * @example
   * const settlement = await invoker.invokeRequest({ record_type: 'provider_warmup_request', ... });
   */
  async invokeRequest(request: JsonValue): Promise<ProviderTransportResult> {
    const outcome = this.#execute(overTheWire(request));
    this.#track(outcome.then(() => undefined));
    return (await outcome).settlement;
  }

  /** Waits until every provider execution, including those the client aborted, has finished. */
  async whenIdle(): Promise<void> {
    while (this.#executions.size > 0) {
      await Promise.all([...this.#executions]);
    }
  }

  /** The refund-call executions that finished, in completion order. */
  finished(): readonly InProcessInvocation[] {
    return [...this.#finished];
  }

  /** Every payload the emulated function received, refund calls and other requests, in order. */
  requests(): readonly JsonValue[] {
    return [...this.#requests];
  }

  async #execute(payload: JsonValue): Promise<ExecutionOutcome> {
    this.#requests.push(payload);
    try {
      const result = await this.#provider.handle(payload);
      return {
        execution: { kind: 'returned', result },
        settlement: this.#response(undefined, result as unknown as JsonValue),
      };
    } catch (error) {
      const failure = runtimeErrorPayload(error);
      return {
        execution: { kind: 'threw', error_type: failure.errorType },
        settlement: this.#response('Unhandled', failure),
      };
    }
  }

  #response(functionError: string | undefined, body: JsonValue | RuntimeErrorPayload): ProviderTransportResult {
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

function overTheWire(request: JsonValue): JsonValue {
  return JSON.parse(canonicalJson(request)) as JsonValue;
}

// The Node.js runtime interface client's `toRapidResponse`, restated (see the header).
function runtimeErrorPayload(error: unknown): RuntimeErrorPayload {
  try {
    return error instanceof Error ? errorObjectPayload(error) : nonErrorPayload(error);
  } catch {
    return UNREADABLE_ERROR_PAYLOAD;
  }
}

function errorObjectPayload(error: Error): RuntimeErrorPayload {
  const stack = error.stack;
  if (stack === undefined) {
    return UNREADABLE_ERROR_PAYLOAD;
  }
  return { errorType: escaped(error.name), errorMessage: escaped(error.message), trace: escaped(stack).split('\n') };
}

// `toString()` throws for null and undefined, which the runtime answers with its fallback.
function nonErrorPayload(error: unknown): RuntimeErrorPayload {
  return { errorType: typeof error, errorMessage: (error as { toString(): string }).toString(), trace: [] };
}

function escaped(text: string): string {
  return text.replaceAll('\x7F', '%7F');
}
