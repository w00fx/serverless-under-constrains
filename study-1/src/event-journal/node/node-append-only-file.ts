// Local file-system binding of the AppendOnlyFile port: one fsync per appended line, and a
// finalized file is made read-only (mode 0444) so the refusal survives the process.
//
// Node facts this relies on (https://nodejs.org/docs/latest-v24.x/api/fs.html):
// - flag 'a+' opens for reading and appending and creates the file when it does not exist;
//   every write lands at the end of the file;
// - `filehandle.appendFile` writes the whole buffer (looping over partial writes);
// - `filehandle.sync()` is fsync(2): data and metadata reach stable storage. A newly created
//   file's directory entry needs an fsync of the directory as well.
// Appends to one path are serialized inside this instance, so the tail check and the write
// cannot interleave with another append from the same process. A torn last line is closed
// with a newline in the same write as the new record (see the port contract).

import type { FileHandle } from 'node:fs/promises';
import { chmod, open, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { AppendOnlyFile, FileAppendOutcome, FileFinalizeOutcome } from '../append-only-file.ts';
import { APPEND_FILE_CODES } from '../append-only-file.ts';

const NEWLINE = 0x0a;
const WRITE_PERMISSION_BITS = 0o222;
const READ_ONLY_MODE = 0o444;

type FileProbe =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly writable: boolean }
  | { readonly kind: 'error'; readonly code: string };

/**
 * The local file-system binding of the `AppendOnlyFile` port, used by the JSONL journals.
 *
 * @example
 * const port = createJsonlJournalPort(join(executionDir, 'runner', 'runner-journal.jsonl'), new NodeAppendOnlyFile());
 */
export class NodeAppendOnlyFile implements AppendOnlyFile {
  readonly #pathTails = new Map<string, Promise<unknown>>();

  /**
   * Appends `bytes` (one or more whole lines) and fsyncs before reporting `appended`. A torn
   * last line is first closed with a lone newline in the same write (port contract).
   *
   * @example
   * await file.append(path, new TextEncoder().encode('{"schema_version":1}\n')); // { kind: 'appended' }
   */
  append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
    return this.#serialized(path, () => appendDurably(path, bytes));
  }

  /**
   * Makes `path` read-only (mode 0444) after an fsync, creating it empty when absent;
   * idempotent. Every later append is refused with `FILE_FINALIZED`.
   *
   * @example
   * await file.finalize(path); // { kind: 'finalized' }
   */
  finalize(path: string): Promise<FileFinalizeOutcome> {
    return this.#serialized(path, () => finalizeDurably(path));
  }

  #serialized<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#pathTails.get(path) ?? Promise.resolve();
    const next = previous.then(task);
    const tail = next.catch(() => undefined);
    this.#pathTails.set(path, tail);
    void tail.then(() => {
      if (this.#pathTails.get(path) === tail) {
        this.#pathTails.delete(path);
      }
    });
    return next;
  }
}

async function appendDurably(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
  const probe = await probeFile(path);
  if (probe.kind === 'error') {
    return { kind: 'not_written', code: probe.code };
  }
  if (probe.kind === 'present' && !probe.writable) {
    return { kind: 'not_written', code: APPEND_FILE_CODES.finalized };
  }
  const opened = await openForAppend(path);
  if (!opened.ok) {
    return { kind: 'not_written', code: opened.code };
  }
  try {
    return await appendThroughHandle(opened.handle, bytes, probe.kind === 'absent' ? dirname(path) : undefined);
  } finally {
    // The outcome is already decided: a close failure after fsync loses no flushed byte.
    await opened.handle.close().catch(() => undefined);
  }
}

async function appendThroughHandle(
  handle: FileHandle,
  bytes: Uint8Array,
  createdIn: string | undefined,
): Promise<FileAppendOutcome> {
  const tail = await endsAtLineBoundary(handle);
  if (typeof tail === 'string') {
    return { kind: 'not_written', code: tail };
  }
  // A torn last line belongs to a stopped source instance (its write was ambiguous). Closing it
  // with its own newline keeps one entry per line, so a restarted instance can keep journaling
  // without merging its record into the fragment (BR-RUA-033 restart semantics).
  const payload = tail ? bytes : withLeadingNewline(bytes);
  try {
    await handle.appendFile(payload);
    await handle.sync();
    if (createdIn !== undefined) {
      await syncDirectory(createdIn);
    }
    return { kind: 'appended' };
  } catch (error: unknown) {
    return { kind: 'unknown', code: errorCode(error) };
  }
}

/** `true` when the file is empty or ends with a newline, `false` when it does not, or a read error code. */
async function endsAtLineBoundary(handle: FileHandle): Promise<boolean | string> {
  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return true;
    }
    const last = new Uint8Array(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === NEWLINE;
  } catch (error: unknown) {
    return errorCode(error);
  }
}

function withLeadingNewline(bytes: Uint8Array): Uint8Array {
  const joined = new Uint8Array(bytes.length + 1);
  joined[0] = NEWLINE;
  joined.set(bytes, 1);
  return joined;
}

async function finalizeDurably(path: string): Promise<FileFinalizeOutcome> {
  const probe = await probeFile(path);
  if (probe.kind === 'error') {
    return { kind: 'failed', code: probe.code };
  }
  if (probe.kind === 'present' && !probe.writable) {
    return { kind: 'finalized' };
  }
  try {
    const handle = await open(path, 'a');
    await handle.sync().finally(() => handle.close());
    if (probe.kind === 'absent') {
      await syncDirectory(dirname(path));
    }
    await chmod(path, READ_ONLY_MODE);
    return { kind: 'finalized' };
  } catch (error: unknown) {
    return { kind: 'failed', code: errorCode(error) };
  }
}

async function probeFile(path: string): Promise<FileProbe> {
  try {
    const stats = await stat(path);
    return { kind: 'present', writable: (stats.mode & WRITE_PERMISSION_BITS) !== 0 };
  } catch (error: unknown) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'error', code };
  }
}

async function openForAppend(
  path: string,
): Promise<{ readonly ok: true; readonly handle: FileHandle } | { readonly ok: false; readonly code: string }> {
  try {
    return { ok: true, handle: await open(path, 'a+') };
  } catch (error: unknown) {
    return { ok: false, code: errorCode(error) };
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  await handle.sync().finally(() => handle.close());
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ?? error.name;
  }
  return typeof error;
}
