// The offline evidence root with a medium that refuses to make files read-only: every finalize
// fails with the scripted code, as a file system that cannot change permissions would answer. The
// runner must then leave `package-index.json` unwritten (BR-RUA-044) and report why.

import type { FileFinalizeOutcome } from '../../../../src/event-journal/append-only-file.ts';
import { OfflinePackageStorage } from '../../../support/offline-cloud/offline-package-storage.ts';

/**
 * Offline package storage whose finalize always fails.
 *
 * @example
 * const storage = new FinalizeRefusingPackageStorage('EPERM');
 * await storage.finalize('runs/x/runner/runner-journal.jsonl'); // { kind: 'failed', code: 'EPERM' }
 */
export class FinalizeRefusingPackageStorage extends OfflinePackageStorage {
  readonly #code: string;
  readonly #refused: string[] = [];

  constructor(code = 'EPERM') {
    super();
    this.#code = code;
  }

  /** The paths whose finalize was refused, in call order. */
  refused(): readonly string[] {
    return [...this.#refused];
  }

  override finalize(path: string): Promise<FileFinalizeOutcome> {
    this.#refused.push(path);
    return Promise.resolve({ kind: 'failed', code: this.#code });
  }
}
