// Named fake of `BundleInputResolver`: returns preset closures. It emulates the esbuild
// adapter: one result per requested entry point in request order, and a rejection naming the
// entry point when it cannot be resolved. `failWith` scripts a bundler failure. Its
// conformance test compares it with `EsbuildBundleInputResolver` over a real project.

import type {
  BundleInputResolver,
  BundleInputs,
} from '../../../../../src/transport-qualification/scope/bundle-inputs.ts';

export class FixedBundleInputResolver implements BundleInputResolver {
  readonly #bundles: Map<string, BundleInputs>;
  readonly #requests: (readonly string[])[] = [];
  #failure: { readonly value: string; readonly asError: boolean } | undefined;

  constructor(bundles: readonly BundleInputs[] = []) {
    this.#bundles = new Map(bundles.map((bundle) => [bundle.entry_point, bundle]));
  }

  /** Every later `resolve` rejects with an Error carrying this message. */
  failWith(message: string): void {
    this.#failure = { value: message, asError: true };
  }

  /** Every later `resolve` rejects with this bare string, as a misbehaving bundler plugin can. */
  failWithNonError(value: string): void {
    this.#failure = { value, asError: false };
  }

  /** The entry-point lists requested so far. */
  requests(): readonly (readonly string[])[] {
    return [...this.#requests];
  }

  resolve(entryPoints: readonly string[]): Promise<readonly BundleInputs[]> {
    this.#requests.push([...entryPoints]);
    if (this.#failure !== undefined) {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- failWithNonError scripts a non-Error rejection
      return Promise.reject(this.#failure.asError ? new Error(this.#failure.value) : this.#failure.value);
    }
    const resolved: BundleInputs[] = [];
    for (const entryPoint of entryPoints) {
      const bundle = this.#bundles.get(entryPoint);
      if (bundle === undefined) {
        return Promise.reject(new Error(`Could not resolve "${entryPoint}"`));
      }
      resolved.push(bundle);
    }
    return Promise.resolve(resolved);
  }
}
