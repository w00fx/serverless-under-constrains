// A defective provider function for the InProcessProviderInvoker conformance test: every
// `handle` rejects with the configured value, which may be an Error or any other value (a
// handler can reject with a string or null). It counts the payloads it received.

import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ProviderInvocationResult } from '../../../src/refund-provider/refund-provider.ts';
import type { InProcessProviderFunction } from './in-process-provider-invoker.ts';

export class RejectingProviderFunction implements InProcessProviderFunction {
  readonly #rejection: unknown;
  readonly #payloads: JsonValue[] = [];

  /** `rejection` is what every `handle` rejects with. */
  constructor(rejection: unknown) {
    this.#rejection = rejection;
  }

  handle(payload: JsonValue): Promise<ProviderInvocationResult> {
    this.#payloads.push(payload);
    // A defective function may reject with a non-Error value; emulating that is this fake's job.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(this.#rejection);
  }

  /** The payloads received, in order. */
  payloads(): readonly JsonValue[] {
    return [...this.#payloads];
  }
}
