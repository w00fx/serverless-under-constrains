// Scripted emulator of the ProviderInvocationPort on virtual time (design §12.2). Each invoke
// consumes the next script. A script that has not settled when the call's signal aborts
// settles at once as the transport error the Lambda binding reports for an aborted request:
// `AbortError` with the message `Request aborted`, which is what `@smithy/node-http-handler`
// 4.12.1 `buildAbortError` produces when the signal aborts while the request is in flight
// (`dist-cjs/index.js`, `onAbort` -> `req.destroy()` -> `reject(buildAbortError(abortSignal))`).
//
// Scripts:
// - resolveAfter(ns, respond): settles with `respond(call)` after `ns` of virtual time;
// - rejectAfter(ns, thrown): rejects the promise with `thrown` after `ns` (a defective port; any
//   value, a null-prototype object or one whose `toString` throws included);
// - hang(): never settles on its own, like a request whose response never arrives;
// - resolveAfterAbort(ns, respond): ignores the abort and settles with `respond(call)` `ns`
//   after it (RK-04: an abort that does not stop a late response);
// - ignoreAbortForever(): ignores the abort and never settles at all (RK-04 at its worst);
// - throwBeforeSend(error): `invoke` throws synchronously, before any promise exists;
// - returnWithoutPromise(respond): a defective port whose `invoke` returns the settlement itself
//   instead of a promise.

import type { MonotonicClock, TimerHandle, TimerScheduler } from '../../../src/record-contract/primitives.ts';
import type { ProviderRefundCall } from '../../../src/record-contract/records/group-a/provider_refund_call.ts';
import type {
  ProviderInvocationPort,
  ProviderTransportResult,
} from '../../../src/provider-client/provider-invocation-port.ts';

/** Builds a settlement from the call it answers, so responses can echo generated ids. */
export type ScriptedResponder = (call: ProviderRefundCall) => ProviderTransportResult;

type InvokerScript =
  | { readonly kind: 'resolve_after'; readonly after_ns: bigint; readonly respond: ScriptedResponder }
  | { readonly kind: 'reject_after'; readonly after_ns: bigint; readonly thrown: unknown }
  | { readonly kind: 'hang' }
  | { readonly kind: 'resolve_after_abort'; readonly after_ns: bigint; readonly respond: ScriptedResponder }
  | { readonly kind: 'ignore_abort_forever' }
  | { readonly kind: 'throw_before_send'; readonly error: Error }
  | { readonly kind: 'return_without_promise'; readonly respond: ScriptedResponder };

export interface RecordedInvocation {
  readonly call: ProviderRefundCall;
  readonly signal: AbortSignal;
  readonly invoked_at_ns: bigint;
}

/** The settlement an aborted in-flight request produces through the Lambda binding. */
export const ABORTED_SETTLEMENT: ProviderTransportResult = {
  kind: 'transport_error',
  error_name: 'AbortError',
  message: 'Request aborted',
};

const NS_PER_MS = 1_000_000;

export class ScriptedProviderInvoker implements ProviderInvocationPort {
  readonly #time: TimerScheduler & MonotonicClock;
  readonly #scripts: InvokerScript[] = [];
  readonly #invocations: RecordedInvocation[] = [];

  constructor(time: TimerScheduler & MonotonicClock) {
    this.#time = time;
  }

  resolveAfter(ns: bigint, respond: ScriptedResponder): void {
    this.#scripts.push({ kind: 'resolve_after', after_ns: ns, respond });
  }

  rejectAfter(ns: bigint, thrown: unknown): void {
    this.#scripts.push({ kind: 'reject_after', after_ns: ns, thrown });
  }

  hang(): void {
    this.#scripts.push({ kind: 'hang' });
  }

  resolveAfterAbort(ns: bigint, respond: ScriptedResponder): void {
    this.#scripts.push({ kind: 'resolve_after_abort', after_ns: ns, respond });
  }

  ignoreAbortForever(): void {
    this.#scripts.push({ kind: 'ignore_abort_forever' });
  }

  throwBeforeSend(error: Error): void {
    this.#scripts.push({ kind: 'throw_before_send', error });
  }

  returnWithoutPromise(respond: ScriptedResponder): void {
    this.#scripts.push({ kind: 'return_without_promise', respond });
  }

  /** Every invoke call in order, including calls that threw. */
  invocations(): readonly RecordedInvocation[] {
    return [...this.#invocations];
  }

  pendingScriptCount(): number {
    return this.#scripts.length;
  }

  invoke(call: ProviderRefundCall, signal: AbortSignal): Promise<ProviderTransportResult> {
    this.#invocations.push({ call, signal, invoked_at_ns: this.#time.nowNs() });
    const script = this.#scripts.shift();
    if (script === undefined) {
      throw new Error(`unscripted invoke of attempt ${call.attempt_id}; expected a script queued before the call`);
    }
    if (script.kind === 'throw_before_send') {
      throw script.error;
    }
    if (script.kind === 'resolve_after_abort') {
      return this.#settleAfterAbort(script.after_ns, () => script.respond(call), signal);
    }
    if (script.kind === 'ignore_abort_forever') {
      return new Promise(() => undefined);
    }
    if (script.kind === 'return_without_promise') {
      return script.respond(call) as unknown as Promise<ProviderTransportResult>;
    }
    return this.#settleUnlessAborted(script, call, signal);
  }

  #settleUnlessAborted(
    script: Extract<InvokerScript, { readonly kind: 'resolve_after' | 'reject_after' | 'hang' }>,
    call: ProviderRefundCall,
    signal: AbortSignal,
  ): Promise<ProviderTransportResult> {
    return new Promise((resolve, reject) => {
      // The listener needs the timer to cancel it and the timer needs the listener to remove it;
      // nothing can abort between the two statements, so the timer is always set when read.
      const pending: { timer?: TimerHandle } = {};
      const onAbort = (): void => {
        pending.timer?.cancel();
        resolve(ABORTED_SETTLEMENT);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (script.kind === 'hang') {
        return;
      }
      pending.timer = this.#time.schedule(Number(script.after_ns) / NS_PER_MS, () => {
        signal.removeEventListener('abort', onAbort);
        if (script.kind === 'reject_after') {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- rejectAfter scripts any thrown value of a defective port
          reject(script.thrown);
          return;
        }
        resolve(script.respond(call));
      });
    });
  }

  #settleAfterAbort(
    afterNs: bigint,
    respond: () => ProviderTransportResult,
    signal: AbortSignal,
  ): Promise<ProviderTransportResult> {
    return new Promise((resolve) => {
      signal.addEventListener(
        'abort',
        () => {
          this.#time.schedule(Number(afterNs) / NS_PER_MS, () => {
            resolve(respond());
          });
        },
        { once: true },
      );
    });
  }
}
