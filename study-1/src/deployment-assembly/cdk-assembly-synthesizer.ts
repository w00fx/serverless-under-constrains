// The production AssemblySynthesizer (design §9.8 S1, §10.1 A12; BR-RUA-042): it writes the
// execution context into the staging directory, runs `cdk synth` once through the injected command
// runner, and checks what the CLI left behind before admission copies it into the package:
// - the stack template and the cloud-assembly manifest exist as regular files;
// - no CLI lock file (`synth.lock`, `read.<pid>.<n>.lock`) remains, since the copy into the package
//   takes every regular file and a lock file is not evidence (RF V1, RK-13).
// A failed or incomplete synthesis is one structured reason; nothing is retried, because the
// assembly is synthesized exactly once per admission attempt.

import { join } from 'node:path';

import type { ExecutionSynthContext } from '../../infra/ownership/execution-context.ts';
import { stackName } from '../../infra/ownership/resource-naming.ts';
import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { FsEntry } from '../evidence-package/package-file-system.ts';
import type { AssemblyFileSystem } from './assembly-file-system.ts';
import type { AssemblySynthesizer, SynthReport } from './assembly-ports.ts';
import { cdkSynthInvocation, EXECUTION_CONTEXT_FILE, SYNTH_OUTPUT_DIR } from './cdk-invocations.ts';
import type { CdkToolSettings } from './cdk-invocations.ts';
import { commandSucceeded, describeCommandResult } from './command-outcome.ts';
import type { CommandRunner } from './command-runner.ts';
import { deploymentReason } from './deployment-reasons.ts';

/** The cloud-assembly manifest every synthesis writes at the assembly root. */
export const CLOUD_ASSEMBLY_MANIFEST = 'manifest.json';
const CONTEXT_FILE_MODE = 0o644;
const LOCK_FILE_SUFFIX = '.lock';

export interface CdkAssemblySynthesizerDeps {
  readonly runner: CommandRunner;
  readonly files: AssemblyFileSystem;
  readonly tools: CdkToolSettings;
}

/**
 * Synthesizes the execution assembly with the pinned CDK CLI.
 *
 * @example
 * const synthesizer = new CdkAssemblySynthesizer({ runner, files, tools });
 * const report = await synthesizer.synthesize(context, '/work/attempt/staging');
 * if (report.ok) report.value.template_file; // 'SucRua-run-3f1c2a9e.template.json'
 */
export class CdkAssemblySynthesizer implements AssemblySynthesizer {
  readonly #deps: CdkAssemblySynthesizerDeps;

  constructor(deps: CdkAssemblySynthesizerDeps) {
    this.#deps = deps;
  }

  /**
   * Writes the context file, runs `cdk synth` and checks the result.
   *
   * @example
   * await synthesizer.synthesize(context, stagingDir); // { ok: true, value: { assembly_dir, ... } }
   */
  async synthesize(context: ExecutionSynthContext, stagingDir: string): Promise<Result<SynthReport, StructuredReason>> {
    const name = stackName(context.execution_kind, context.execution_id);
    const invocation = cdkSynthInvocation(this.#deps.tools, stagingDir, name);
    if (!invocation.ok) {
      return invocation;
    }
    const contextFile = join(stagingDir, EXECUTION_CONTEXT_FILE);
    const written = await this.#deps.files.createFile(
      contextFile,
      new TextEncoder().encode(`${JSON.stringify(context)}\n`),
      CONTEXT_FILE_MODE,
    );
    if (!written.ok) {
      return err(synthReason('SYNTH_CONTEXT_NOT_WRITTEN', `${written.error.code}: ${written.error.detail}`));
    }
    const result = await this.#deps.runner.run(invocation.value);
    if (!commandSucceeded(result)) {
      return err(synthReason('SYNTH_FAILED', `cdk synth ${describeCommandResult(result)}; expected exit status 0`));
    }
    const report: SynthReport = {
      assembly_dir: join(stagingDir, SYNTH_OUTPUT_DIR),
      stack_name: name,
      template_file: `${name}.template.json`,
      context_file: contextFile,
    };
    return this.#checkAssembly(report);
  }

  async #checkAssembly(report: SynthReport): Promise<Result<SynthReport, StructuredReason>> {
    const listed = await this.#deps.files.list(report.assembly_dir);
    if (!listed.ok) {
      return err(synthReason('SYNTH_OUTPUT_MISSING', `${listed.error.code}: ${listed.error.detail}`));
    }
    const problem = assemblyProblem(listed.value, report.template_file);
    return problem === undefined ? ok(report) : err(problem);
  }
}

function assemblyProblem(entries: readonly FsEntry[], templateFile: string): StructuredReason | undefined {
  const files = new Set(entries.filter((entry) => entry.type === 'file').map((entry) => entry.path));
  const missing = [templateFile, CLOUD_ASSEMBLY_MANIFEST].filter((required) => !files.has(required));
  if (missing.length > 0) {
    return synthReason(
      'SYNTH_OUTPUT_MISSING',
      `the assembly lacks ${boundedJsonText(missing)}; expected the stack template and ${CLOUD_ASSEMBLY_MANIFEST} as regular files`,
    );
  }
  const locks = [...files].filter((path) => path.endsWith(LOCK_FILE_SUFFIX));
  if (locks.length > 0) {
    return synthReason(
      'SYNTH_LOCK_FILE_LEFT',
      `the assembly still holds ${boundedJsonText(locks)}; expected no CDK CLI lock file after synthesis`,
    );
  }
  return undefined;
}

function synthReason(code: string, detail: string): StructuredReason {
  return deploymentReason(code, 'BR-RUA-042', detail);
}
