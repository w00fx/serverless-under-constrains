// FakeCommandRunner (design §12.2): the CDK CLI as a scripted subprocess. It records every
// invocation, answers with the queued results in order (exit status 0 when none is queued) and
// reproduces the CLI's file effects that the deployment assembly relies on, each one proven
// against the pinned CLI 2.1144.0 by `fakes/fake-command-runner.conformance.integration.test.ts`:
// - every run is a new process with its own pid (4242, 4243, ...);
// - `deploy --app <dir>` takes a read lock on the cloud assembly in `<dir>` before anything else
//   (lib/index.js L309889 `new RWLock(app).acquireRead()`): the file `read.<pid>.1.lock`
//   (L113250), holding the pid. The CLI releases it when it exits on its own, with any status,
//   and leaves it when a signal kills it, so the fake removes it unless the result is `signalled`;
// - a deployment that exits 0 writes the scripted outputs JSON to `--outputs-file`;
// - `synth --output <dir>` that exits 0 materializes the scripted assembly files in `<dir>`.

import { join } from 'node:path';

import type { Result } from '../../../src/record-contract/primitives.ts';
import type { FileSystemFailure } from '../../../src/evidence-package/package-file-system.ts';
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from '../../../src/deployment-assembly/command-runner.ts';

/** Where the fake writes the CLI's file effects: the memory emulator or a real directory. */
export interface CommandFileEffects {
  createFile(path: string, bytes: Uint8Array, mode: number): Promise<Result<void, FileSystemFailure>>;
  removeFile(path: string): Promise<void>;
}

/** A file the scripted synthesis writes, relative to its `--output` directory. */
export interface ScriptedAssemblyFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

/** The first pid the fake hands out. */
export const FAKE_FIRST_PID = 4242;
const CLI_FILE_MODE = 0o644;
const SUCCESS: CommandResult = { kind: 'exited', exit_code: 0, stdout: '', stderr: '' };
const encoder = new TextEncoder();

export class FakeCommandRunner implements CommandRunner {
  readonly #effects: CommandFileEffects;
  readonly #invocations: CommandInvocation[] = [];
  readonly #queued: CommandResult[] = [];
  readonly #locksWritten: string[] = [];
  #synthFiles: readonly ScriptedAssemblyFile[] = [];
  #deployOutputs: Uint8Array | undefined;
  #nextPid = FAKE_FIRST_PID;

  constructor(effects: CommandFileEffects) {
    this.#effects = effects;
  }

  /** Queues the result of the next run that has none queued yet. */
  enqueue(result: CommandResult): void {
    this.#queued.push(result);
  }

  /** The files every successful synthesis writes into its `--output` directory. */
  scriptSynthOutput(files: readonly ScriptedAssemblyFile[]): void {
    this.#synthFiles = files;
  }

  /** The bytes every successful deployment writes to its `--outputs-file`. */
  scriptDeployOutputs(bytes: Uint8Array | string): void {
    this.#deployOutputs = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  }

  /** Every invocation run so far, in order. */
  invocations(): readonly CommandInvocation[] {
    return [...this.#invocations];
  }

  /** The absolute path of every read lock a deployment wrote, released or not. */
  locksWritten(): readonly string[] {
    return [...this.#locksWritten];
  }

  async run(invocation: CommandInvocation): Promise<CommandResult> {
    this.#invocations.push(invocation);
    const pid = this.#nextPid;
    this.#nextPid += 1;
    const result = this.#queued.shift() ?? SUCCESS;
    const command = invocation.args[1];
    if (command === 'deploy') {
      await this.#deploy(invocation, pid, result);
    }
    if (command === 'synth' && isSuccess(result)) {
      await this.#synth(invocation);
    }
    return result;
  }

  async #deploy(invocation: CommandInvocation, pid: number, result: CommandResult): Promise<void> {
    const lock = join(requiredOption(invocation, '--app'), `read.${String(pid)}.1.lock`);
    await this.#write(lock, encoder.encode(String(pid)), CLI_FILE_MODE);
    this.#locksWritten.push(lock);
    if (isSuccess(result) && this.#deployOutputs !== undefined) {
      await this.#write(requiredOption(invocation, '--outputs-file'), this.#deployOutputs, CLI_FILE_MODE);
    }
    if (result.kind !== 'signalled') {
      await this.#effects.removeFile(lock);
    }
  }

  async #synth(invocation: CommandInvocation): Promise<void> {
    const output = requiredOption(invocation, '--output');
    for (const file of this.#synthFiles) {
      await this.#write(join(output, file.path), file.bytes, file.mode);
    }
  }

  async #write(path: string, bytes: Uint8Array, mode: number): Promise<void> {
    const written = await this.#effects.createFile(path, bytes, mode);
    if (!written.ok) {
      throw new Error(
        `fake CLI could not write ${JSON.stringify(path)}: ${written.error.code}; expected a writable path`,
      );
    }
  }
}

function isSuccess(result: CommandResult): boolean {
  return result.kind === 'exited' && result.exit_code === 0;
}

function requiredOption(invocation: CommandInvocation, option: string): string {
  const value = invocation.args[invocation.args.indexOf(option) + 1];
  if (!invocation.args.includes(option) || value === undefined) {
    throw new Error(`invocation ${JSON.stringify(invocation.args)} lacks ${option}; expected the option with a value`);
  }
  return value;
}
