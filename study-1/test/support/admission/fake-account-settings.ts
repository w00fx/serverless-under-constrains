// FakeAccountSettings (design §12.2): the Lambda account-settings port with a scripted
// `UnreservedConcurrentExecutions`. It emulates `createAccountSettingsReader`: an answered call is
// the unreserved concurrency, a failed one keeps the SDK error's name and message. Its
// conformance test runs the production adapter over a scripted Lambda endpoint.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { AccountSettingsReadPort, PortFailure, PortResult } from '../../../src/admission/admission-ports.ts';

/** The account default unreserved concurrency of a fresh account. */
export const DEFAULT_UNRESERVED_CONCURRENCY = 1000;

/**
 * The unreserved concurrency as scripted.
 *
 * @example
 * await new FakeAccountSettings(5).readUnreservedConcurrency(); // { ok: true, value: 5 }
 */
export class FakeAccountSettings implements AccountSettingsReadPort {
  readonly #unreserved: number;
  #failure: PortFailure | undefined;

  constructor(unreserved: number = DEFAULT_UNRESERVED_CONCURRENCY) {
    this.#unreserved = unreserved;
  }

  /** Every later read fails with this failure. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  readUnreservedConcurrency(): PortResult<number> {
    return Promise.resolve(this.#failure === undefined ? ok(this.#unreserved) : err(this.#failure));
  }
}
