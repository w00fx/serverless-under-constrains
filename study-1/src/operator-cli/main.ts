// Process entry of the operator CLI, `npm run rua -- <command> [flags]` (design §11, §15.1).
// Wiring only (design §15.4: excluded from the mutation targets): it binds the process's argument
// vector, streams and environment to `main` and sets the exit code; `cli-main.ts` decides.

import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { main } from './cli-main.ts';
import { createCompositionRoot } from './composition-root.ts';

const studyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

process.exitCode = await main(
  process.argv.slice(2),
  {
    stdout: (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line: string): void => {
      process.stderr.write(`${line}\n`);
    },
  },
  createCompositionRoot({
    studyRoot,
    cwd: process.cwd(),
    env: process.env,
    tempRoot: tmpdir(),
    nodeVersion: process.version,
  }),
);
