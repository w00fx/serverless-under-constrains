// `rua probe execute`, `rua validation execute` and `rua run execute` (design §11, §10.2 P1-P9;
// AC-RUA-002, AC-RUA-021, AC-RUA-027): run one admitted package through the execution runner.
// Before anything can mutate the cloud the command checks, in order:
//   1. the operand is a package directory of the command's kind (usage error otherwise);
//   2. its frozen execution manifest reads back and names that execution (exit 5 otherwise);
//   3. `--confirm-cloud-mutation` equals the admitted execution id (usage error otherwise);
//   4. the package was never executed: no runner journal exists yet (exit 5 otherwise), so a
//      repeated command can never deploy a second stack for one admitted execution;
//   5. the runner can be built: the frozen manifest addresses every table (exit 5 otherwise).
// While the runner works, the first interrupt (SIGINT) asks it to stop with `OPERATOR_ABORT`; every
// later one is only reported on stderr, because cleanup must never be abandoned (design §11). The
// exit code comes from the runner's outcome (`execution-exit.ts`).

import type { AbortAnswer } from '../execution-lifecycle/execution-gate.ts';
import type { AdmittedExecution, ExecutionOutcome } from '../execution-lifecycle/execution-ports.ts';
import type { PackageFileSystem } from '../evidence-package/package-file-system.ts';
import { EXECUTION_PATHS, executionIdOf } from '../evidence-package/package-layout.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { ExecutionKind, Result, StructuredReason } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { readAdmittedPackage } from './admitted-package.ts';
import { operandOf } from './arg-parsing.ts';
import { failedOutcome } from './cli-result.ts';
import type { CliCommand, CliOutcomeReport, CommandContext, CommandSpec, ParsedArgs } from './cli-types.ts';
import { CONFIRM_FLAG, confirmCloudMutation } from './cloud-confirmation.ts';
import { executionReport } from './execution-exit.ts';

/** The runner of one admitted execution, as the command drives it (`ExecutionRunner`). */
export interface ExecutionSession {
  runProbe(): Promise<ExecutionOutcome>;
  runValidation(): Promise<ExecutionOutcome>;
  runCanonical(): Promise<ExecutionOutcome>;
  abort(detail: string): AbortAnswer;
}

/**
 * Builds the runner of one admitted execution over the evidence root (production: AWS), or why the
 * frozen manifest cannot address its resources (for example a coordination table ARN with no name).
 */
export type ExecutionSessionFactory = (
  admitted: AdmittedExecution,
  evidenceRoot: string,
) => Result<ExecutionSession, StructuredReason>;

/** Operator interrupts (production: the process's SIGINT). */
export interface InterruptSource {
  /** Calls `listener` on every interrupt until the returned function is called. */
  subscribe(listener: () => void): () => void;
}

/** What an execute command reads and runs through. */
export interface ExecuteCommandDeps {
  readonly files: (evidenceRoot: string) => PackageFileSystem;
  readonly validator: RecordValidator;
  readonly sessions: ExecutionSessionFactory;
  readonly interrupts: InterruptSource;
}

interface KindGrammar {
  readonly word: string;
  readonly run: (session: ExecutionSession) => Promise<ExecutionOutcome>;
}

const KIND_GRAMMAR: Readonly<Record<ExecutionKind, KindGrammar>> = {
  TRANSPORT_PROBE: { word: 'probe', run: (session) => session.runProbe() },
  VARIANT_VALIDATION: { word: 'validation', run: (session) => session.runValidation() },
  RUN: { word: 'run', run: (session) => session.runCanonical() },
};

const PACKAGE_OPERAND = 'package';

/**
 * One `<kind> execute <package> --confirm-cloud-mutation <id>` command.
 *
 * @example
 * const command = new ExecuteCommand('RUN', { files, validator, sessions, interrupts });
 * await main(['run', 'execute', 'evidence/runs/<id>', '--confirm-cloud-mutation', '<id>'], io, root);
 */
export class ExecuteCommand implements CliCommand {
  readonly spec: CommandSpec;
  readonly #kind: ExecutionKind;
  readonly #deps: ExecuteCommandDeps;

  constructor(kind: ExecutionKind, deps: ExecuteCommandDeps) {
    const { word } = KIND_GRAMMAR[kind];
    this.#kind = kind;
    this.#deps = deps;
    this.spec = {
      words: [word, 'execute'],
      positionals: [PACKAGE_OPERAND],
      flags: new Map([[CONFIRM_FLAG, 'required']]),
      usage: `${word} execute <package> --${CONFIRM_FLAG} <execution_id>`,
    };
  }

  async run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    const admitted = await this.#admitted(args, context);
    if (!admitted.ok) {
      return admitted.error;
    }
    const built = this.#deps.sessions(admitted.value, context.evidence_root);
    if (!built.ok) {
      return { ...failedOutcome('verification_failed', [built.error]), execution: admitted.value.identity };
    }
    const session = built.value;
    const unsubscribe = this.#deps.interrupts.subscribe(() => {
      context.progress(interruptLine(session.abort('SIGINT')));
    });
    context.progress(`executing ${admitted.value.package_directory}`);
    try {
      return executionReport(admitted.value, await KIND_GRAMMAR[this.#kind].run(session));
    } finally {
      unsubscribe();
    }
  }

  // Steps 1-4 of the header; the admitted execution, or the report that refuses it.
  async #admitted(args: ParsedArgs, context: CommandContext): Promise<Result<AdmittedExecution, CliOutcomeReport>> {
    const files = this.#deps.files(context.evidence_root);
    const admitted = await readAdmittedPackage(operandOf(args, PACKAGE_OPERAND), context, {
      files,
      validator: this.#deps.validator,
      kind: this.#kind,
    });
    if (!admitted.ok) {
      return admitted;
    }
    const confirmed = confirmCloudMutation(args, executionIdOf(admitted.value.identity));
    if (!confirmed.ok) {
      return err(failedOutcome('usage_error', [confirmed.error]));
    }
    const fresh = await neverExecuted(files, admitted.value);
    return fresh === undefined ? ok(admitted.value) : err(failedOutcome('verification_failed', [fresh]));
  }
}

// The runner journal is the runner's first write (P1 `started`), so its absence proves no run began.
async function neverExecuted(
  files: PackageFileSystem,
  admitted: AdmittedExecution,
): Promise<StructuredReason | undefined> {
  const path = `${admitted.package_directory}/${EXECUTION_PATHS.runnerJournal}`;
  const read = await files.read(path);
  if (!read.ok && read.error.code === 'NOT_FOUND') {
    return undefined;
  }
  const found = read.ok ? 'exists' : `cannot be checked (${read.error.code}: ${read.error.detail})`;
  return {
    code: 'PACKAGE_ALREADY_EXECUTED',
    subject: 'BR-RUA-040',
    artifact_path: EXECUTION_PATHS.runnerJournal,
    detail: `${path} ${found}; expected an admitted package that no runner has started`,
  };
}

function interruptLine(answer: AbortAnswer): string {
  return answer === 'interrupting'
    ? 'SIGINT: interrupting the execution (OPERATOR_ABORT); cleanup still runs to its end'
    : 'SIGINT again: the execution is already interrupted; cleanup still runs to its end';
}
