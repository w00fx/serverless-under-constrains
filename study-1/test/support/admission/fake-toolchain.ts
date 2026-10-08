// FakeToolchain (design §12.2): the toolchain port with scripted facts. It emulates
// `ToolchainReader`: the Node version is always present, npm, esbuild and the CDK CLI versions
// are present only when installed, and the dependency-tree check is a flag with its detail. Its
// conformance test reads this repository's real toolchain through both and compares the facts'
// shape and the A6 verdict.

import { err, ok } from '../../../src/record-contract/primitives.ts';
import type {
  PortFailure,
  PortResult,
  ToolchainFacts,
  ToolchainReadPort,
} from '../../../src/admission/admission-ports.ts';
import { SUPPORTED_TOOLCHAIN } from './admission-fixtures.ts';

/**
 * The toolchain as scripted; a supported one by default.
 *
 * @example
 * const toolchain = new FakeToolchain({ node_version: 'v22.11.0' });
 * await toolchain.readToolchain(); // { ok: true, value: { node_version: 'v22.11.0', … } }
 */
export class FakeToolchain implements ToolchainReadPort {
  #facts: ToolchainFacts;
  #failure: PortFailure | undefined;

  constructor(overrides: Partial<ToolchainFacts> = {}) {
    this.#facts = { ...SUPPORTED_TOOLCHAIN, ...overrides };
  }

  /** Replaces the scripted facts. */
  set(facts: ToolchainFacts): void {
    this.#facts = facts;
  }

  /** Every later read fails with this failure. */
  failWith(code: string, detail: string): void {
    this.#failure = { code, detail };
  }

  readToolchain(): PortResult<ToolchainFacts> {
    return Promise.resolve(this.#failure === undefined ? ok({ ...this.#facts }) : err(this.#failure));
  }
}
