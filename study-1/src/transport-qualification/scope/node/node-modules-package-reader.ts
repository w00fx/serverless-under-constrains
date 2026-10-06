// Reads the installed version of a package from `<projectRoot>/<installPath>/package.json`, the
// manifest of the copy the bundler resolves (BR-RUA-028 "the transport implementation scope it
// actually exercised"). Only a missing manifest reads as "not installed"; an unreadable or
// malformed one rejects, so it can never pass for an absent package.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describeJson, isJsonObject } from '../../../record-contract/json-value.ts';
import { parseJsonDocument } from '../../../record-contract/parsing.ts';
import type { InstalledPackageReader } from '../scope-recomputation.ts';

export interface NodeModulesPackageReaderDeps {
  /** Absolute path of the project root (the directory holding `package.json` and `node_modules`). */
  readonly projectRoot: string;
}

// ENOENT: no such file; ENOTDIR: a path segment is a file. Either way nothing is installed there.
const NOT_INSTALLED_CODES: ReadonlySet<unknown> = new Set(['ENOENT', 'ENOTDIR']);

/**
 * The production `InstalledPackageReader`.
 *
 * @example
 * const installed = new NodeModulesPackageReader({ projectRoot: '/repo/study-1' });
 * await installed.installedVersion('node_modules/esbuild'); // '0.28.2'
 */
export class NodeModulesPackageReader implements InstalledPackageReader {
  readonly #projectRoot: string;

  constructor(deps: NodeModulesPackageReaderDeps) {
    this.#projectRoot = deps.projectRoot;
  }

  async installedVersion(installPath: string): Promise<string | undefined> {
    const manifestPath = `${installPath}/package.json`;
    const bytes = await this.#readManifest(manifestPath);
    if (bytes === undefined) {
      return undefined;
    }
    const parsed = parseJsonDocument(bytes);
    if (!parsed.ok) {
      throw new Error(`${manifestPath} is not one JSON document (${parsed.error.kind}); expected a package manifest`);
    }
    const version =
      isJsonObject(parsed.value) && Object.hasOwn(parsed.value, 'version') ? parsed.value['version'] : undefined;
    if (typeof version !== 'string') {
      throw new Error(`${manifestPath} has version ${describeJson(version)}; expected a string`);
    }
    return version;
  }

  async #readManifest(manifestPath: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(join(this.#projectRoot, manifestPath));
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (NOT_INSTALLED_CODES.has(code)) {
        return undefined;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${manifestPath} cannot be read: ${message}; expected a readable package manifest`, {
        cause: error,
      });
    }
  }
}
