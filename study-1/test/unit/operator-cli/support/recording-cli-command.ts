// A named command double for `main` (design §12.2 rule against inline stubs): it has a grammar,
// answers every run with a scripted report or throws a scripted value, and records each run's
// arguments and context. It replaces no external I/O, only the command a test routes to.

import type {
  CliCommand,
  CliOutcomeReport,
  CommandContext,
  CommandSpec,
  FlagPresence,
  ParsedArgs,
} from '../../../../src/operator-cli/cli-types.ts';

export interface RecordedRun {
  readonly args: ParsedArgs;
  readonly context: CommandContext;
}

export class RecordingCliCommand implements CliCommand {
  readonly spec: CommandSpec;
  readonly runs: RecordedRun[] = [];
  #report: CliOutcomeReport = { outcome: 'completed', written_paths: [], reasons: [] };
  #thrown: Error | undefined;

  constructor(
    words: readonly string[],
    positionals: readonly string[],
    flags: Readonly<Record<string, FlagPresence>> = {},
  ) {
    this.spec = {
      words,
      positionals,
      flags: new Map(Object.entries(flags)),
      usage: [...words, ...positionals.map((name) => `<${name}>`)].join(' '),
    };
  }

  /** Every later run answers `report`. */
  answer(report: CliOutcomeReport): void {
    this.#report = report;
  }

  /** Every later run rejects with `error`. */
  throwOnRun(error: Error): void {
    this.#thrown = error;
  }

  run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport> {
    this.runs.push({ args, context });
    if (this.#thrown !== undefined) {
      return Promise.reject(this.#thrown);
    }
    return Promise.resolve(this.#report);
  }
}
