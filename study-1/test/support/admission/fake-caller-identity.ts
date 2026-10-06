// FakeCallerIdentity (design §12.2): the caller-identity port with a scripted identity. It
// emulates `createCallerIdentityReader`: an answered `sts:GetCallerIdentity` is the account, the
// ARN and the configured Region, and a failed call keeps the SDK error's name and message as the
// failure's code and detail. Its conformance test runs the production adapter over a scripted
// STS endpoint answering the same identity and failure.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type {
  CallerIdentity,
  CallerIdentityPort,
  PortFailure,
  PortResult,
} from '../../../src/admission/admission-ports.ts';
import { ACCOUNT_ID, CALLER_ARN } from './admission-fixtures.ts';

/**
 * The caller identity as scripted; the allowlisted account in `us-east-1` by default.
 *
 * @example
 * const sts = new FakeCallerIdentity({ account: '109876543210' });
 * await sts.readCallerIdentity(); // { ok: true, value: { account: '109876543210', … } }
 */
export class FakeCallerIdentity implements CallerIdentityPort {
  #identity: CallerIdentity;
  #failure: PortFailure | undefined;
  #reads = 0;

  constructor(overrides: Partial<CallerIdentity> = {}) {
    this.#identity = { account: ACCOUNT_ID, arn: CALLER_ARN, region: 'us-east-1', ...overrides };
  }

  /** Every later read fails with this failure. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  /** How many times the identity was read. */
  readCount(): number {
    return this.#reads;
  }

  readCallerIdentity(): PortResult<CallerIdentity> {
    this.#reads += 1;
    return Promise.resolve(this.#failure === undefined ? ok({ ...this.#identity }) : err(this.#failure));
  }
}
