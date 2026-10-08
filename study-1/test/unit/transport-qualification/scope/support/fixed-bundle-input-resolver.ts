// Named fake of `BundleInputResolver`: returns preset closures. It emulates the esbuild
// adapter: one result per requested entry point in request order, a rejection naming the
// entry point when it cannot be resolved, and the same bundling runtime properties unless a
// test presets others. `failWith` scripts a bundler failure. Its conformance test compares it
// with `EsbuildBundleInputResolver` over a real project.

import { SCOPE_BUNDLE_RUNTIME_PROPERTIES } from '../../../../../src/transport-qualification/scope/bundle-inputs.ts';
import type {
  BundleInputResolver,
  BundleInputs,
} from '../../../../../src/transport-qualification/scope/bundle-inputs.ts';

export class FixedBundleInputResolver implements BundleInputResolver {
  readonly runtime_properties: Readonly<Record<string, string | number | boolean>>;
  readonly #bundles: Map<string, BundleInputs>;
  readonly #requests: (readonly string[])[] = [];
  #failure: { readonly value: string; readonly asError: boolean } | undefined;

  constructor(
    bundles: readonly BundleInputs[] = [],
    runtimeProperties: Readonly<Record<string, string | number | boolean>> = SCOPE_BUNDLE_RUNTIME_PROPERTIES,
  ) {
    this.#bundles = new Map(bundles.map((bundle) => [bundle.entry_point, bundle]));
    this.runtime_properties = runtimeProperties;
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
