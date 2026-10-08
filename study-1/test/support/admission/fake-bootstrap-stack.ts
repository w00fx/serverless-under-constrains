// FakeBootstrapStack (design §12.2): the `CDKToolkit` stack port with a scripted status. It
// emulates `createBootstrapStackReader`: an existing stack reads as its status, a missing stack
// reads as `undefined` (CloudFormation's "does not exist" answer is an answer, not a failure),
// and any other failure keeps the SDK error's name and message. Its conformance test runs the
// production adapter over a scripted CloudFormation endpoint.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type { BootstrapStackReadPort, PortFailure, PortResult } from '../../../src/admission/admission-ports.ts';

/**
 * The bootstrap stack as scripted; `UPDATE_COMPLETE` by default.
 *
 * @example
 * const bootstrap = new FakeBootstrapStack();
 * bootstrap.removeStack();
 * await bootstrap.readBootstrapStackStatus(); // { ok: true, value: undefined }
 */
export class FakeBootstrapStack implements BootstrapStackReadPort {
  #status: string | undefined;
  #failure: PortFailure | undefined;

  constructor(status = 'UPDATE_COMPLETE') {
    this.#status = status;
  }

  /** The stack does not exist (never bootstrapped, or deleted). */
  removeStack(): void {
    this.#status = undefined;
  }

  /** Every later read fails with this failure. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  readBootstrapStackStatus(): PortResult<string | undefined> {
    return Promise.resolve(this.#failure === undefined ? ok(this.#status) : err(this.#failure));
  }
}
