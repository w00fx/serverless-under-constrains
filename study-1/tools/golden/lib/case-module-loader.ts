// The module-loading port of the golden fixture generator: a case file is a TypeScript module
// whose default export is the case. Loading runs the module, so it is the one step that can fail
// with an exception (a syntax error, a throwing import); the generator reports that failure for
// the case instead of stopping the run.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { boundedText } from '../../../src/record-contract/json-value.ts';

/** The outcome of loading one case module. */
export type CaseModuleResult =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

/** Loads the default export of a case module, by root-relative path. */
export interface CaseModuleLoader {
  load(caseFile: string): Promise<CaseModuleResult>;
}

/**
 * The Node binding: dynamic `import()` of the case file under `root`.
 *
 * @example
 * const loaded = await new NodeCaseModuleLoader(process.cwd()).load('test/golden/x/cases/a.case.ts');
 */
export class NodeCaseModuleLoader implements CaseModuleLoader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  /**
   * Imports the module and returns its default export.
   *
   * @example
   * await loader.load('test/golden/_harness/cases/base-probe.case.ts'); // { ok: true, value: {...} }
   */
  async load(caseFile: string): Promise<CaseModuleResult> {
    try {
      const loaded: unknown = await import(pathToFileURL(join(this.#root, caseFile)).href);
      const exports =
        typeof loaded === 'object' && loaded !== null ? Object.getOwnPropertyDescriptor(loaded, 'default') : undefined;
      return exports === undefined
        ? { ok: false, error: `${caseFile} has no default export; expected export default defineGoldenCase({...})` }
        : { ok: true, value: exports.value };
    } catch (error: unknown) {
      return { ok: false, error: `${caseFile} failed to load (${thrownText(error)}); expected an importable module` };
    }
  }
}

// `String()` throws on a thrown value without a callable `toString` (`throw Object.create(null)`),
// which would stop the run this port exists to keep going, and a long message would flood the
// report; the text is bounded by the kernel helper (A-05, WP-09 single-pass review).
function thrownText(error: unknown): string {
  try {
    return boundedText(String(error));
  } catch {
    return 'a thrown value with no text form';
  }
}
