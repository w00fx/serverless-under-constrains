// The production toolchain port (design §10.1 A6): the running Node version, the npm version,
// the locally installed esbuild and aws-cdk versions read from their `package.json` under
// `node_modules`, and whether `npm ls --all --json --package-lock-only` finds the dependency tree
// consistent with the lockfile. Every command runs without a shell; nothing is installed.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isJsonObject } from '../../record-contract/json-value.ts';
import { parseJsonDocument } from '../../record-contract/parsing.ts';
import { ownField } from '../../trial-message/trial-message-fields.ts';
import type { PortResult, ToolchainFacts, ToolchainReadPort } from '../admission-ports.ts';

const NPM_LS_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

export interface ToolchainReaderDeps {
  /** Absolute path of the study root (`study-1/`). */
  readonly studyRoot: string;
  /** `process.version` of the running Node. */
  readonly nodeVersion: string;
  /** The npm executable; defaults to `npm` on the PATH. */
  readonly npmExecutable?: string;
}

interface CommandOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Reads the local toolchain facts.
 *
 * @example
 * await new ToolchainReader({ studyRoot: '/repo/study-1', nodeVersion: process.version }).readToolchain();
 */
export class ToolchainReader implements ToolchainReadPort {
  readonly #deps: ToolchainReaderDeps;

  constructor(deps: ToolchainReaderDeps) {
    this.#deps = deps;
  }

  async readToolchain(): PortResult<ToolchainFacts> {
    const npm = this.#deps.npmExecutable ?? 'npm';
    const version = await this.#run(npm, ['--version']);
    const tree = await this.#run(npm, ['ls', '--all', '--json', '--package-lock-only']);
    const esbuild = this.#installedVersion('esbuild');
    const cdk = this.#installedVersion('aws-cdk');
    return {
      ok: true,
      value: {
        node_version: this.#deps.nodeVersion,
        ...(version.exitCode === 0 ? { npm_version: version.stdout.trim() } : {}),
        ...(esbuild === undefined ? {} : { esbuild_version: esbuild }),
        ...(cdk === undefined ? {} : { aws_cdk_cli_version: cdk }),
        dependency_tree_consistent: tree.exitCode === 0,
        dependency_tree_detail:
          tree.exitCode === 0
            ? 'npm ls exited 0'
            : `npm ls exited ${String(tree.exitCode)}: ${tree.stderr.slice(-500)}`,
      },
    };
  }

  #installedVersion(name: string): string | undefined {
    // An absent or unreadable manifest reads as "not installed", which A6 rejects.
    const bytes = manifestBytes(join(this.#deps.studyRoot, 'node_modules', name, 'package.json'));
    const parsed = bytes === undefined ? undefined : parseJsonDocument(bytes);
    const version = parsed?.ok === true && isJsonObject(parsed.value) ? ownField(parsed.value, 'version') : undefined;
    return typeof version === 'string' ? version : undefined;
  }

  #run(executable: string, args: readonly string[]): Promise<CommandOutput> {
    return new Promise((resolve) => {
      execFile(
        executable,
        [...args],
        { cwd: this.#deps.studyRoot, encoding: 'utf8', maxBuffer: NPM_LS_MAX_BUFFER_BYTES },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 127;
          resolve({ exitCode: code, stdout, stderr: error !== null && stderr === '' ? error.message : stderr });
        },
      );
    });
  }
}

// `readFileSync` throws on an absent, unreadable or directory path; each reads as no manifest
// instead of escaping the port (A-05; WP-23 review).
function manifestBytes(path: string): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
}
