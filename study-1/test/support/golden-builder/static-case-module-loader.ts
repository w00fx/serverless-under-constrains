// The in-memory emulator of the generator's case-module port. Each registered path behaves like a
// module file: it exports a default value, exports no default, or throws while it is evaluated;
// an unregistered path fails like an absent file. The shared conformance suite holds it to the
// outcome classes of `NodeCaseModuleLoader`.

import type { CaseModuleLoader, CaseModuleResult } from '../../../tools/golden/lib/case-module-loader.ts';

/** How one registered module behaves when loaded. */
export type StaticCaseModule =
  | { readonly kind: 'default_export'; readonly value: unknown }
  | { readonly kind: 'no_default_export' }
  | { readonly kind: 'throws'; readonly message: string };

/**
 * A case-module loader over registered modules, keyed by root-relative path.
 *
 * @example
 * const loader = new StaticCaseModuleLoader(new Map([['test/golden/x/cases/a.case.ts', { kind: 'default_export', value: aCase }]]));
 * await loader.load('test/golden/x/cases/a.case.ts'); // { ok: true, value: aCase }
 */
export class StaticCaseModuleLoader implements CaseModuleLoader {
  readonly #modules: ReadonlyMap<string, StaticCaseModule>;
  readonly #loaded: string[] = [];

  constructor(modules: ReadonlyMap<string, StaticCaseModule>) {
    this.#modules = modules;
  }

  /**
   * The registered module's outcome, in the binding's message shapes.
   *
   * @example
   * await loader.load('test/golden/x/cases/missing.case.ts'); // { ok: false, error: '... failed to load ...' }
   */
  load(caseFile: string): Promise<CaseModuleResult> {
    this.#loaded.push(caseFile);
    const module = this.#modules.get(caseFile);
    if (module === undefined) {
      return Promise.resolve(failure(caseFile, `Error: Cannot find module '${caseFile}'`));
    }
    if (module.kind === 'throws') {
      return Promise.resolve(failure(caseFile, `Error: ${module.message}`));
    }
    return Promise.resolve(
      module.kind === 'default_export'
        ? { ok: true, value: module.value }
        : { ok: false, error: `${caseFile} has no default export; expected export default defineGoldenCase({...})` },
    );
  }

  /**
   * Every path loaded so far, in call order.
   *
   * @example
   * loader.loadedPaths(); // ['test/golden/x/cases/a.case.ts']
   */
  loadedPaths(): readonly string[] {
    return [...this.#loaded];
  }
}

function failure(caseFile: string, cause: string): CaseModuleResult {
  return { ok: false, error: `${caseFile} failed to load (${cause}); expected an importable module` };
}
