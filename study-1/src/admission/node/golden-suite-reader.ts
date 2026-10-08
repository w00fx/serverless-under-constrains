// The production golden-suite port (BR-RUA-055, design §10.1 A9, D-18): runs
// `npm run test:golden -- --report-json <report>` at the admitted HEAD through the injected
// command runner, reads the report's exact bytes, and loads every committed trial-oracle golden
// case's declaration (`test/golden/trial-oracle/**/cases/*.case.ts`, default export). The suite
// only reads the source and writes its report outside the evidence root. Nothing escapes the port
// as a throw (A-05; WP-23 review): a previous report that cannot be removed fails the read, since
// a stale report could otherwise be attested, and a case module that throws while loading
// declares nothing, so it covers no rule.

import { globSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CommandRunner } from '../../deployment-assembly/command-runner.ts';
import type { GoldenCaseDeclaration, GoldenSuiteReadPort, GoldenSuiteRun, PortResult } from '../admission-ports.ts';
import { caseDeclarationOf } from '../golden-report.ts';
import { TRIAL_ORACLE_GOLDEN_DIRECTORY } from '../oracle-attestation.ts';

const CASE_FILE_PATTERN = `${TRIAL_ORACLE_GOLDEN_DIRECTORY}**/cases/*.case.ts`;

export interface GoldenSuiteReaderDeps {
  readonly runner: CommandRunner;
  /** Absolute path of the study root (`study-1/`). */
  readonly studyRoot: string;
  /** Absolute path the report is written to; it is replaced on every run. */
  readonly reportPath: string;
  /** The npm executable and the environment the suite runs with. */
  readonly npmExecutable: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Runs the golden suite and reads what it attests.
 *
 * @example
 * await new GoldenSuiteReader({ runner, studyRoot, reportPath, npmExecutable: 'npm', env }).readGoldenSuiteRun();
 */
export class GoldenSuiteReader implements GoldenSuiteReadPort {
  readonly #deps: GoldenSuiteReaderDeps;

  constructor(deps: GoldenSuiteReaderDeps) {
    this.#deps = deps;
  }

  async readGoldenSuiteRun(): PortResult<GoldenSuiteRun> {
    const args = ['run', 'test:golden', '--', '--report-json', this.#deps.reportPath];
    try {
      rmSync(this.#deps.reportPath, { force: true });
    } catch (error: unknown) {
      return { ok: false, error: { code: 'GOLDEN_REPORT_NOT_CLEARED', detail: String(error) } };
    }
    const result = await this.#deps.runner.run({
      executable: this.#deps.npmExecutable,
      args,
      cwd: this.#deps.studyRoot,
      env: this.#deps.env,
    });
    if (result.kind === 'spawn_failed') {
      return { ok: false, error: { code: 'GOLDEN_SUITE_NOT_STARTED', detail: result.detail } };
    }
    let reportBytes: Uint8Array;
    try {
      reportBytes = new Uint8Array(readFileSync(this.#deps.reportPath));
    } catch (error: unknown) {
      return { ok: false, error: { code: 'GOLDEN_REPORT_UNREADABLE', detail: String(error) } };
    }
    return {
      ok: true,
      value: {
        command: `${this.#deps.npmExecutable} ${args.join(' ')}`,
        exit_code: result.kind === 'exited' ? result.exit_code : 255,
        report_bytes: reportBytes,
        case_declarations: await this.#caseDeclarations(),
      },
    };
  }

  async #caseDeclarations(): Promise<readonly GoldenCaseDeclaration[]> {
    const files = globSync(CASE_FILE_PATTERN, { cwd: this.#deps.studyRoot }).toSorted();
    const declarations: GoldenCaseDeclaration[] = [];
    for (const file of files) {
      const declaration = caseDeclarationOf(await this.#defaultExport(file));
      if (declaration !== undefined) {
        declarations.push(declaration);
      }
    }
    return declarations;
  }

  async #defaultExport(file: string): Promise<unknown> {
    try {
      const loaded = (await import(pathToFileURL(join(this.#deps.studyRoot, file)).href)) as {
        readonly default?: unknown;
      };
      return loaded.default;
    } catch {
      return undefined;
    }
  }
}
