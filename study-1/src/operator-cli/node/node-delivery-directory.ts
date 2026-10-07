// The local billing delivery directory `billing import --export <dir>` reads (design §8.17): every
// entry below it, depth first and sorted by path, regular files with their exact bytes and every
// other entry (a symbolic link, a FIFO, a device) without bytes, so the delivery check refuses it.
// Symbolic links are listed, never followed (`lstat`), so a delivery cannot pull in a file from
// outside its directory. The bytes are untrusted; judging them is `checkDelivery`'s job.

import type { Stats } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { err, ok } from '../../record-contract/primitives.ts';
import type { Result } from '../../record-contract/primitives.ts';
import type { DeliveryDirectoryReader } from '../billing-import-command.ts';
import type { DeliveryEntry } from '../billing-delivery.ts';

interface ReadFailure {
  readonly code: string;
  readonly detail: string;
}

/**
 * Reads a delivery directory from the local file system.
 *
 * @example
 * const entries = await new NodeDeliveryDirectory().read('/exports/2026-10');
 * if (entries.ok) entries.value.map((entry) => entry.path); // ['data/x-00001.csv.gz', 'x-Manifest.json']
 */
export class NodeDeliveryDirectory implements DeliveryDirectoryReader {
  async read(directory: string): Promise<Result<readonly DeliveryEntry[], ReadFailure>> {
    const entries: DeliveryEntry[] = [];
    const pending: string[] = [''];
    try {
      for (let relative = pending.pop(); relative !== undefined; relative = pending.pop()) {
        await readLevel(directory, relative, entries, pending);
      }
    } catch (thrown: unknown) {
      const failure = thrown as NodeJS.ErrnoException;
      return err({ code: failure.code ?? 'IO_ERROR', detail: failure.message });
    }
    return ok(entries.toSorted((a, b) => (a.path < b.path ? -1 : 1)));
  }
}

async function readLevel(root: string, relative: string, entries: DeliveryEntry[], pending: string[]): Promise<void> {
  for (const name of await readdir(join(root, relative))) {
    const path = relative === '' ? name : `${relative}/${name}`;
    const stats: Stats = await lstat(join(root, path));
    if (stats.isDirectory()) {
      pending.push(path);
      continue;
    }
    entries.push(stats.isFile() ? { path, bytes: new Uint8Array(await readFile(join(root, path))) } : { path });
  }
}
