// The operator CLI's own contract (design §5.3 L7 `operator-cli/`, §11; D-14): the commands it
// knows, the arguments one invocation carries, what a command reports and the I/O it prints
// through. stdout carries exactly one canonical-JSON `cli_result` line and stderr plain-text
// progress, so a command never writes to either directly: it returns a `CliOutcome` and reports
// progress through its context. Type-only: no runtime part (A-10).

import type { ExecutionIdentity, JsonObject, StructuredReason, WallClock } from '../record-contract/primitives.ts';
import type { RecordValidator } from '../record-contract/schema-registry.ts';
import type { CliOutcome } from '../record-contract/records/group-c/vocabulary.ts';

/** Where the CLI prints. */
export interface CliIo {
  /** Receives exactly one line per invocation: the canonical-JSON `cli_result`. */
  readonly stdout: (line: string) => void;
  /** Receives plain-text progress and usage lines. */
  readonly stderr: (line: string) => void;
}

/** Whether a flag must be given. Every flag of design §11 takes exactly one value. */
export type FlagPresence = 'required' | 'optional';

/** The grammar of one command: its words, its positional operands and its flags. */
export interface CommandSpec {
  /** The command words, for example `['probe', 'verify']`. */
  readonly words: readonly string[];
  /** The names of the positional operands, in order; every one is required. */
  readonly positionals: readonly string[];
  /** Flag names without the leading `--`, each with its presence. */
  readonly flags: ReadonlyMap<string, FlagPresence>;
  /** One line shown on a usage error, for example `probe verify <package> [--head <sha256>]`. */
  readonly usage: string;
}

/** One invocation, parsed against the command it names. */
export interface ParsedArgs {
  /** The command words joined by one space, for example `probe verify`. */
  readonly command: string;
  readonly positionals: ReadonlyMap<string, string>;
  readonly flags: ReadonlyMap<string, string>;
  /** The global `--evidence-root` value as given, or the default `evidence`. */
  readonly evidence_root: string;
}

/** What a command run sees besides its own dependencies. */
export interface CommandContext {
  /** The evidence root as an absolute path. */
  readonly evidence_root: string;
  /** Resolves an operand path against the working directory. */
  readonly resolvePath: (path: string) => string;
  /** Plain-text progress on stderr. */
  readonly progress: (line: string) => void;
}

/** What a command reports; `main` turns it into the `cli_result` line and the exit code. */
export interface CliOutcomeReport {
  readonly outcome: CliOutcome;
  /** The execution the command concerned, when it concerned one. */
  readonly execution?: ExecutionIdentity;
  /** Paths written, relative to the evidence root. */
  readonly written_paths: readonly string[];
  /** The record the command produced, printed inside the result. */
  readonly result_record?: JsonObject;
  readonly reasons: readonly StructuredReason[];
}

/** One operator command. */
export interface CliCommand {
  readonly spec: CommandSpec;
  run(args: ParsedArgs, context: CommandContext): Promise<CliOutcomeReport>;
}

/** What `main` needs: the commands, the clock that stamps results and the schema validator. */
export interface CompositionRoot {
  readonly commands: readonly CliCommand[];
  readonly clock: WallClock;
  readonly validator: RecordValidator;
  /** Resolves the evidence root flag against the working directory. */
  readonly resolvePath: (path: string) => string;
}
