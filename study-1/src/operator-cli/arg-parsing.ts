// The operator CLI grammar (design §11): `<word> [<word>] <operand>... [--flag <value>]...`. The
// command is the longest run of leading words that names a known command; the operands follow it
// in order, and every flag takes exactly one value. `--evidence-root <dir>` is global. The argument
// vector is operator input, so parsing is total (A-05): flags live in maps, never as properties of
// a plain object, so an inherited name such as `--constructor` is just an unknown flag; and every
// refusal is a `USAGE_ERROR` reason naming the offending token and the expected shape.

import { boundedJsonText } from '../record-contract/json-value.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { Result, StructuredReason } from '../record-contract/primitives.ts';
import type { CommandSpec, ParsedArgs } from './cli-types.ts';

/** The global flag every command accepts (design §11). */
export const EVIDENCE_ROOT_FLAG = 'evidence-root';
/** The evidence root when `--evidence-root` is not given. */
export const DEFAULT_EVIDENCE_ROOT = 'evidence';

const FLAG_PREFIX = '--';
const FLAG_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Anything with a command grammar. */
export interface HasSpec {
  readonly spec: CommandSpec;
}

/**
 * Parses an argument vector against the known commands.
 *
 * @example
 * parseArgs(['probe', 'verify', 'evidence/transport-probes/x', '--head', sha], commands);
 * // { ok: true, value: { command: 'probe verify', positionals: Map { package → … }, flags: Map { head → sha }, … } }
 */
export function parseArgs(argv: readonly string[], commands: readonly HasSpec[]): Result<ParsedArgs, StructuredReason> {
  const command = matchCommand(argv, commands);
  return command === undefined ? err(unknownCommandReason(argv, commands)) : parseCommandArgs(argv, command.spec);
}

/**
 * Parses an argument vector whose leading words name `spec`'s command.
 *
 * @example
 * parseCommandArgs(['oracle', 'evaluate', 'trials/t'], spec); // { ok: true, value: { command: 'oracle evaluate', … } }
 */
export function parseCommandArgs(argv: readonly string[], spec: CommandSpec): Result<ParsedArgs, StructuredReason> {
  const split = splitOperands(argv.slice(spec.words.length), spec);
  if (!split.ok) {
    return split;
  }
  const { operands, flags } = split.value;
  const positionals = nameOperands(operands, spec);
  if (!positionals.ok) {
    return positionals;
  }
  const missing = [...spec.flags].filter(([name, presence]) => presence === 'required' && !flags.has(name));
  if (missing.length > 0) {
    return err(usageReason(`--${missing.map(([name]) => name).join(', --')} missing`, `usage: ${spec.usage}`));
  }
  const evidenceRoot = flags.get(EVIDENCE_ROOT_FLAG) ?? DEFAULT_EVIDENCE_ROOT;
  flags.delete(EVIDENCE_ROOT_FLAG);
  return ok({ command: spec.words.join(' '), positionals: positionals.value, flags, evidence_root: evidenceRoot });
}

/**
 * The usage error of an argument vector that names no known command.
 *
 * @example
 * unknownCommandReason(['launch'], commands).detail; // 'no known command starts ["launch"]; expected one of: …'
 */
export function unknownCommandReason(argv: readonly string[], commands: readonly HasSpec[]): StructuredReason {
  return usageReason(`no known command starts ${quoteTokens(argv.slice(0, 2))}`, knownCommands(commands));
}

/**
 * The usage lines of every command, one per line, for stderr after a usage error.
 *
 * @example
 * usageLines(commands); // ['oracle evaluate <trial-dir>', …]
 */
export function usageLines(commands: readonly HasSpec[]): readonly string[] {
  return commands.map((command) => `rua ${command.spec.usage} [--${EVIDENCE_ROOT_FLAG} <dir>]`);
}

/**
 * The command whose words are the longest prefix of the argument vector, if any.
 *
 * @example
 * matchCommand(['run', 'verify', 'evidence/runs/x'], commands)?.spec.usage; // 'run verify <package> [--head <sha256>]'
 */
export function matchCommand<Command extends HasSpec>(
  argv: readonly string[],
  commands: readonly Command[],
): Command | undefined {
  let best: Command | undefined;
  for (const command of commands) {
    const matches = command.spec.words.every((word, index) => argv[index] === word);
    if (matches && command.spec.words.length > (best?.spec.words.length ?? 0)) {
      best = command;
    }
  }
  return best;
}

interface SplitArguments {
  readonly operands: readonly string[];
  readonly flags: Map<string, string>;
}

function splitOperands(rest: readonly string[], spec: CommandSpec): Result<SplitArguments, StructuredReason> {
  const operands: string[] = [];
  const flags = new Map<string, string>();
  // One iterator, so a flag's value is consumed with it and is never read as an operand.
  const tokens = rest.values();
  for (let step = tokens.next(); step.done !== true; step = tokens.next()) {
    const token = step.value;
    if (token.length === 0) {
      return err(usageReason('an empty operand was given', `usage: ${spec.usage}`));
    }
    if (!token.startsWith(FLAG_PREFIX)) {
      operands.push(token);
      continue;
    }
    const flag = readFlag(token, tokens.next().value, spec, flags);
    if (!flag.ok) {
      return flag;
    }
    flags.set(flag.value.name, flag.value.value);
  }
  return ok({ operands, flags });
}

// Pairs each operand with its grammar name; too many and too few operands are one usage error.
function nameOperands(
  operands: readonly string[],
  spec: CommandSpec,
): Result<ReadonlyMap<string, string>, StructuredReason> {
  const named = new Map<string, string>();
  for (const [index, value] of operands.entries()) {
    const name = spec.positionals[index];
    if (name === undefined) {
      return err(operandCountReason(operands, spec));
    }
    named.set(name, value);
  }
  return named.size === spec.positionals.length ? ok(named) : err(operandCountReason(operands, spec));
}

function operandCountReason(operands: readonly string[], spec: CommandSpec): StructuredReason {
  return usageReason(
    `${String(operands.length)} operand(s) ${quoteTokens(operands)} were given`,
    `usage: ${spec.usage}`,
  );
}

function readFlag(
  token: string,
  value: string | undefined,
  spec: CommandSpec,
  seen: ReadonlyMap<string, string>,
): Result<{ readonly name: string; readonly value: string }, StructuredReason> {
  const name = token.slice(FLAG_PREFIX.length);
  const known = FLAG_NAME_PATTERN.test(name) && (name === EVIDENCE_ROOT_FLAG || spec.flags.has(name));
  if (!known) {
    return err(usageReason(`flag ${quoteTokens([token])} is not a flag of this command`, `usage: ${spec.usage}`));
  }
  if (seen.has(name)) {
    return err(usageReason(`flag --${name} was given twice`, 'each flag at most once'));
  }
  if (value === undefined || value.startsWith(FLAG_PREFIX) || value.length === 0) {
    return err(usageReason(`flag --${name} has no value`, `--${name} <value>`));
  }
  return ok({ name, value });
}

function knownCommands(commands: readonly HasSpec[]): string {
  return `one of: ${commands.map((command) => command.spec.words.join(' ')).join(', ')}`;
}

function quoteTokens(tokens: readonly string[]): string {
  return boundedJsonText(tokens);
}

/**
 * A usage-error reason (exit code 2).
 *
 * @example
 * usageReason('--env missing', 'usage: probe admit --env <file>');
 */
export function usageReason(problem: string, expected: string): StructuredReason {
  return { code: 'USAGE_ERROR', subject: 'operator-cli', detail: `${problem}; expected ${expected}` };
}

/**
 * The value of a named operand; a parse always gives every operand of the grammar, so the empty
 * fallback only answers a caller that asks for a name its grammar lacks.
 *
 * @example
 * operandOf(args, 'package'); // 'evidence/runs/0b6d…'
 */
export function operandOf(args: ParsedArgs, name: string): string {
  return args.positionals.get(name) ?? '';
}
