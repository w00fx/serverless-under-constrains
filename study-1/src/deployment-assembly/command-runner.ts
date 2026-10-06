// The subprocess port of the deployment assembly (design §12.2 `FakeCommandRunner`): the CDK CLI
// runs as a child process for synthesis (§9.8 S1) and deployment (D2). An invocation names the
// executable and its argument vector directly, so no shell parses it, and carries the complete
// environment, so nothing is inherited implicitly. The result is a value in every case: a process
// that could not start is `spawn_failed`, never a rejection. Type-only: it has no runtime part (A-10).

/** One subprocess to run: no shell, an explicit working directory and the whole environment. */
export interface CommandInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

/** How a subprocess ended; `stdout` and `stderr` keep at most the last 64 KiB of each stream. */
export type CommandResult =
  | { readonly kind: 'exited'; readonly exit_code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'signalled'; readonly signal: string; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'spawn_failed'; readonly detail: string };

/**
 * Runs one subprocess to completion.
 */
export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
}
