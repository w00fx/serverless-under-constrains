// Offline stand-in for the runner's synchronous Invoke of the provider's published version with
// the warm-up request (addendum §2.1, design §5.3 `ProviderWarmupInvoker`): the request crosses the
// same emulated Lambda Invoke as the callers' refund calls (InProcessProviderInvoker), so the real
// provider journals `provider_warmup_completed` in `<execution_id>#warmup`.
//
// Test hook: `failNext(settlement)` makes the next warm-up settle as given without invoking.

import type { ProviderTransportResult } from '../../../src/provider-client/provider-invocation-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ProviderWarmupRequest } from '../../../src/record-contract/records/group-b/provider_warmup_request.ts';
import type { ProviderWarmupInvoker } from '../../../src/trial-execution/trial-execution-ports.ts';
import type { InProcessProviderInvoker } from '../transport-rehearsal/in-process-provider-invoker.ts';

export class OfflineProviderWarmupInvoker implements ProviderWarmupInvoker {
  readonly #invoker: InProcessProviderInvoker;
  readonly #requests: ProviderWarmupRequest[] = [];
  #scripted: ProviderTransportResult | undefined;

  constructor(invoker: InProcessProviderInvoker) {
    this.#invoker = invoker;
  }

  invokeWarmup(request: ProviderWarmupRequest): Promise<ProviderTransportResult> {
    this.#requests.push(request);
    const scripted = this.#scripted;
    this.#scripted = undefined;
    return scripted === undefined
      ? this.#invoker.invokeRequest(request as unknown as JsonValue)
      : Promise.resolve(scripted);
  }

  /** The next warm-up settles as `settlement` without reaching the provider. */
  failNext(settlement: ProviderTransportResult): void {
    this.#scripted = settlement;
  }

  /** Every warm-up request, in order. */
  requests(): readonly ProviderWarmupRequest[] {
    return [...this.#requests];
  }
}
