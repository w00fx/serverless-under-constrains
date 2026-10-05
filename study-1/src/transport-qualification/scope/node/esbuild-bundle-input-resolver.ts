// Resolves the transitive production closure of each transport entry point with esbuild's
// metafile, which lists every bundled file (design CF V-1 / RF V2). The options mirror the
// `ObservableFunction` bundling of `infra/constructs/observable-function.ts` (ESM, Node 24,
// `module,main` main fields, AWS SDK bundled because nothing is external), so the closure is
// what the deployed functions contain. Nothing is written to disk.

import { build } from 'esbuild';

import type { BundleInputResolver, BundleInputs } from '../bundle-inputs.ts';
import { SCOPE_BUNDLE_RUNTIME_PROPERTIES, classifyBundleInputs } from '../bundle-inputs.ts';

export interface EsbuildBundleInputResolverDeps {
  /** Absolute path of the project root (the directory holding `package.json`). */
  readonly projectRoot: string;
}

/**
 * The production `BundleInputResolver`.
 *
 * @example
 * const resolver = new EsbuildBundleInputResolver({ projectRoot: '/repo/study-1' });
 * const [provider] = await resolver.resolve(['src/refund-provider/refund-provider.handler.ts']);
 */
export class EsbuildBundleInputResolver implements BundleInputResolver {
  readonly #projectRoot: string;

  constructor(deps: EsbuildBundleInputResolverDeps) {
    this.#projectRoot = deps.projectRoot;
  }

  async resolve(entryPoints: readonly string[]): Promise<readonly BundleInputs[]> {
    const resolved: BundleInputs[] = [];
    for (const entryPoint of entryPoints) {
      resolved.push(await this.#resolveOne(entryPoint));
    }
    return resolved;
  }

  async #resolveOne(entryPoint: string): Promise<BundleInputs> {
    const result = await build({
      entryPoints: [entryPoint],
      absWorkingDir: this.#projectRoot,
      bundle: true,
      write: false,
      metafile: true,
      logLevel: 'silent',
      platform: SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_platform,
      format: SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_format,
      target: SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_target,
      mainFields: SCOPE_BUNDLE_RUNTIME_PROPERTIES.bundle_main_fields.split(','),
    });
    return classifyBundleInputs(entryPoint, Object.keys(result.metafile.inputs));
  }
}
