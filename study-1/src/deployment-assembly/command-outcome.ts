// How a CDK CLI subprocess ended, as the reasons of synthesis and deployment state it. The CLI's
// stderr is untrusted text of any length, so a detail quotes only its bounded tail. The tail is
// long enough to reach past a Node stack trace (about a dozen frames, the Node version and the
// CLI's own line) to the error message the app threw, which a 400-character tail cut off.

import { boundedText } from '../record-contract/json-value.ts';
import type { CommandResult } from './command-runner.ts';

/** How many trailing characters of stderr a detail quotes. */
export const STDERR_TAIL_CHARACTERS = 2000;

/**
 * True when the subprocess ran and exited with status 0.
 *
 * @example
 * if (!commandSucceeded(result)) return failure(describeCommandResult(result));
 */
export function commandSucceeded(result: CommandResult): boolean {
  return result.kind === 'exited' && result.exit_code === 0;
}

/**
 * One line naming how the subprocess ended and the tail of its stderr.
 *
 * @example
 * describeCommandResult({ kind: 'exited', exit_code: 1, stdout: '', stderr: 'boom' });
 * // 'exited with status 1; stderr tail: boom'
 */
export function describeCommandResult(result: CommandResult): string {
  switch (result.kind) {
    case 'spawn_failed':
      return `could not start: ${boundedText(result.detail)}`;
    case 'signalled':
      return `ended by signal ${boundedText(result.signal)}; stderr tail: ${stderrTail(result.stderr)}`;
    case 'exited':
      return `exited with status ${String(result.exit_code)}; stderr tail: ${stderrTail(result.stderr)}`;
  }
}

function stderrTail(stderr: string): string {
  return boundedText(stderr.slice(-STDERR_TAIL_CHARACTERS), STDERR_TAIL_CHARACTERS);
}
