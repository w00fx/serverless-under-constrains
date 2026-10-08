// The admission harness's synthesizer (design §12.2): the production `CdkAssemblySynthesizer`
// over the scripted CDK CLI, with the CLI's output scripted from each synthesis context first. A
// real `cdk synth` names the execution and the admission instant in the cloud assembly (the stack
// name and the BR-RUA-050 ownership tags of its manifest), and admission only learns both at A11,
// so the output cannot be scripted before admission starts.

import type { ExecutionSynthContext } from '../../../infra/ownership/execution-context.ts';
import type { Result, StructuredReason } from '../../../src/record-contract/primitives.ts';
import type { AssemblySynthesizer, SynthReport } from '../../../src/deployment-assembly/assembly-ports.ts';
import type { FakeCommandRunner, ScriptedAssemblyFile } from '../deployment-assembly/fake-command-runner.ts';

/** The files the scripted `cdk synth` writes for one synthesis context. */
export type SynthScript = (context: ExecutionSynthContext) => readonly ScriptedAssemblyFile[];

export interface ContextScriptedSynthesizerDeps {
  readonly runner: FakeCommandRunner;
  readonly script: SynthScript;
  /** The synthesizer under test, running over `runner`. */
  readonly synthesizer: AssemblySynthesizer;
}

/**
 * Scripts the fake CLI's synthesis output from the context, then synthesizes.
 *
 * @example
 * const synthesizer = new ContextScriptedSynthesizer({ runner, script: synthesizedAssemblyFiles, synthesizer: cdk });
 * await synthesizer.synthesize(context, '/staging/attempt'); // writes the assembly of `context`
 */
export class ContextScriptedSynthesizer implements AssemblySynthesizer {
  readonly #deps: ContextScriptedSynthesizerDeps;

  constructor(deps: ContextScriptedSynthesizerDeps) {
    this.#deps = deps;
  }

  synthesize(context: ExecutionSynthContext, stagingDir: string): Promise<Result<SynthReport, StructuredReason>> {
    this.#deps.runner.scriptSynthOutput(this.#deps.script(context));
    return this.#deps.synthesizer.synthesize(context, stagingDir);
  }
}
