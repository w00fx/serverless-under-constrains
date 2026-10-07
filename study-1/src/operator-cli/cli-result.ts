// The one stdout line of an invocation (design §11, catalogue row 88 `cli_result`; D-14): the
// command, its outcome and the exit code that outcome has, the execution it concerned, the paths
// it wrote below the evidence root, the record it produced and every reason. The exit code is a
// function of the outcome alone (`CLI_OUTCOMES` / `CLI_EXIT_CODES`), so no command can pair an
// outcome with another code.

import { reasonFromThrown } from '../cleanup/thrown-reason.ts';
import { executionIdentityFields } from '../record-contract/envelope.ts';
import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { CliResult } from '../record-contract/records/group-c/cli_result.ts';
import { CLI_EXIT_CODES, CLI_OUTCOMES } from '../record-contract/records/group-c/vocabulary.ts';
import type { CliExitCode, CliOutcome } from '../record-contract/records/group-c/vocabulary.ts';
import type { CliOutcomeReport } from './cli-types.ts';

// The two vocabulary tuples zipped once: outcome → its code, keyed only by the closed outcome set.
const EXIT_CODE_OF = Object.fromEntries(
  CLI_OUTCOMES.map((outcome, index) => [outcome, CLI_EXIT_CODES[index]]),
) as Readonly<Record<CliOutcome, CliExitCode>>;

/**
 * The exit code of an outcome (design §11 table).
 *
 * @example
 * exitCodeOf('verification_failed'); // 5
 */
export function exitCodeOf(outcome: CliOutcome): CliExitCode {
  return EXIT_CODE_OF[outcome];
}

/**
 * The `cli_result` record of one invocation.
 *
 * @example
 * toCliResult({ outcome: 'completed', written_paths: [], reasons: [] }, 'oracle revision-check', now).exit_code; // 0
 */
export function toCliResult(report: CliOutcomeReport, command: string, completedAt: UtcMillis): CliResult {
  return {
    schema_version: 1,
    record_type: 'cli_result',
    command,
    outcome: report.outcome,
    exit_code: exitCodeOf(report.outcome),
    ...(report.execution === undefined ? {} : executionIdentityFields(report.execution)),
    written_paths: [...new Set(report.written_paths)],
    ...(report.result_record === undefined ? {} : { result_record: report.result_record }),
    reasons: [...report.reasons],
    completed_at: completedAt,
  } as CliResult;
}

/**
 * An outcome with only reasons: the command wrote nothing and produced no record.
 *
 * @example
 * failedOutcome('usage_error', [usageReason('--env missing', 'usage: probe admit --env <file>')]);
 */
export function failedOutcome(outcome: CliOutcome, reasons: readonly StructuredReason[]): CliOutcomeReport {
  return { outcome, written_paths: [], reasons };
}

/**
 * The reason a command failed internally, from whatever it threw (exit code 10). Total over every
 * thrown value (Owner amendment A-05): it runs inside `main`'s catch, so an Error whose `name` or
 * `message` is a throwing getter or a Symbol must still yield the one result line (WP-28 review F2;
 * the earlier template literal threw there and `main` printed nothing).
 *
 * @example
 * internalReason(new Error('disk full')); // { code: 'INTERNAL_FAILURE', … detail: 'threw Error: disk full; …' }
 */
export function internalReason(thrown: unknown): StructuredReason {
  return reasonFromThrown(thrown, 'INTERNAL_FAILURE', 'operator-cli');
}
