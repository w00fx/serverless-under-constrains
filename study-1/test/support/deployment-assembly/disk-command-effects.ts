// The FakeCommandRunner's file effects on a real directory: files are created through the local
// binding `NodeAssemblyFileSystem` (exact mode, never overwriting) and released with `rm`, so a
// fake deployment touches the disk exactly where the pinned CLI would.

import { rm } from 'node:fs/promises';

import { NodeAssemblyFileSystem } from '../../../src/deployment-assembly/node/node-assembly-file-system.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import type { FileSystemFailure } from '../../../src/evidence-package/package-file-system.ts';
import type { CommandFileEffects } from './fake-command-runner.ts';

export class DiskCommandEffects implements CommandFileEffects {
  readonly #files = new NodeAssemblyFileSystem();

  createFile(path: string, bytes: Uint8Array, mode: number): Promise<Result<void, FileSystemFailure>> {
    return this.#files.createFile(path, bytes, mode);
  }

  removeFile(path: string): Promise<void> {
    return rm(path, { force: true });
  }
}
