// The operator CLI's entry logic (design §5.3 `main`, §11): parse the argument vector, run the one
// command it names, and print exactly one canonical-JSON `cli_result` line on stdout; return the
// exit code its outcome has. A usage error prints the usage lines on stderr. A command that throws
// is reported as `internal_failure` (exit 10), never as a crash with no result line. The line is
// validated against the `cli_result` schema before it is printed, so a command cannot print a
// result that breaks the catalogue (for example a written path outside the evidence root).

import { canonicalJson } from '../record-contract/canonical-json.ts';
import { boundedJsonText, boundedText } from '../record-contract/json-value.ts';
import type { JsonValue, StructuredReason } from '../record-contract/primitives.ts';
import type { CliResult } from '../record-contract/records/group-c/cli_result.ts';
import { formatUtcMillis } from '../record-contract/timestamps.ts';
import { matchCommand, parseCommandArgs, unknownCommandReason, usageLines } from './arg-parsing.ts';
import { failedOutcome, internalReason, toCliResult } from './cli-result.ts';
import type { CliCommand, CliIo, CliOutcomeReport, CompositionRoot, ParsedArgs } from './cli-types.ts';

/** The command name a result carries when no known command was named. */
export const UNNAMED_COMMAND = 'rua';

/**
 * Runs one CLI invocation and returns its exit code.
 *
 * @example
 * process.exitCode = await main(process.argv.slice(2), io, createCompositionRoot(process.cwd()));
 */
export async function main(argv: readonly string[], io: CliIo, root: CompositionRoot): Promise<number> {
  const command = matchCommand(argv, root.commands);
  const report =
    command === undefined
      ? usageFailure(unknownCommandReason(argv, root.commands), io, root.commands)
      : await runNamedCommand(command, argv, io, root);
  const commandName = command === undefined ? UNNAMED_COMMAND : command.spec.words.join(' ');
  const result = checkedResult(toCliResult(report, commandName, formatUtcMillis(root.clock.now())), root);
  io.stdout(canonicalJson(result as unknown as JsonValue));
  return result.exit_code;
}

async function runNamedCommand(
  command: CliCommand,
  argv: readonly string[],
  io: CliIo,
  root: CompositionRoot,
): Promise<CliOutcomeReport> {
  const parsed = parseCommandArgs(argv, command.spec);
  return parsed.ok ? runCommand(command, parsed.value, io, root) : usageFailure(parsed.error, io, root.commands);
}

// A usage error prints every command's usage line on stderr, then reports exit code 2.
function usageFailure(reason: StructuredReason, io: CliIo, commands: readonly CliCommand[]): CliOutcomeReport {
  for (const line of usageLines(commands)) {
    io.stderr(line);
  }
  return failedOutcome('usage_error', [reason]);
}

async function runCommand(
  command: CliCommand,
  args: ParsedArgs,
  io: CliIo,
  root: CompositionRoot,
): Promise<CliOutcomeReport> {
  try {
    return await command.run(args, {
      evidence_root: root.resolvePath(args.evidence_root),
      resolvePath: root.resolvePath,
      progress: io.stderr,
    });
  } catch (thrown: unknown) {
    return failedOutcome('internal_failure', [internalReason(thrown)]);
  }
}

// A result that breaks the catalogue is replaced by an internal failure naming its violations.
function checkedResult(result: CliResult, root: CompositionRoot): CliResult {
  const validation = root.validator.validateAs('cli_result', result as unknown as JsonValue);
  if (validation.valid) {
    return result;
  }
  const where = boundedText(
    validation.violations.map((violation) => `${violation.instance_path} ${violation.keyword}`).join(', '),
  );
  return toCliResult(
    failedOutcome('internal_failure', [
      {
        code: 'CLI_RESULT_INVALID',
        subject: 'operator-cli',
        detail: `the ${boundedJsonText(result.command)} result breaks the cli_result schema at ${where}; expected a valid cli_result`,
      },
    ]),
    result.command,
    result.completed_at,
  );
}
