// In-memory emulator of the AppendOnlyFile port (design §12.2). It reproduces the behavior of
// the file-system binding `NodeAppendOnlyFile` that the shared conformance suite proves on both:
// files are created on first append, bytes accumulate in call order, a finalized file refuses
// every append without writing, and a file whose last byte is not a newline (a torn line)
// refuses appends that would merge two records.
//
// Fault injection: `failWriteAt(path, line, effect)` makes the append that would write line
// `line` of `path` fail once, with one of the three fates a real write can have:
// - `nothing_written`: no byte reaches the file (`not_written`, for example EACCES on open);
// - `torn_write`: the first half of the bytes reaches the file (`unknown`, a write cut short);
// - `written_unacknowledged`: every byte reaches the file but the flush fails (`unknown`).

import type {
  AppendOnlyFile,
  FileAppendOutcome,
  FileFinalizeOutcome,
} from '../../../src/event-journal/append-only-file.ts';
import { APPEND_FILE_CODES } from '../../../src/event-journal/append-only-file.ts';

export type ScriptedFileWriteEffect = 'nothing_written' | 'torn_write' | 'written_unacknowledged';

interface MemoryFile {
  bytes: Uint8Array;
  finalized: boolean;
}

interface ScriptedFileFault {
  readonly path: string;
  readonly line: number;
  readonly effect: ScriptedFileWriteEffect;
  readonly code: string;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

export class MemoryAppendOnlyFile implements AppendOnlyFile {
  readonly #files = new Map<string, MemoryFile>();
  readonly #faults: ScriptedFileFault[] = [];

  append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome> {
    const file = this.#files.get(path) ?? { bytes: new Uint8Array(0), finalized: false };
    if (file.finalized) {
      return Promise.resolve({ kind: 'not_written', code: APPEND_FILE_CODES.finalized });
    }
    if (file.bytes.length > 0 && file.bytes[file.bytes.length - 1] !== NEWLINE) {
      return Promise.resolve({ kind: 'not_written', code: APPEND_FILE_CODES.tornTail });
    }
    const fault = this.#takeFault(path, countLines(file.bytes) + 1);
    if (fault?.effect === 'nothing_written') {
      return Promise.resolve({ kind: 'not_written', code: fault.code });
    }
    const written = fault?.effect === 'torn_write' ? bytes.slice(0, Math.floor(bytes.length / 2)) : bytes;
    this.#files.set(path, { bytes: concat(file.bytes, written), finalized: false });
    return Promise.resolve(fault === undefined ? { kind: 'appended' } : { kind: 'unknown', code: fault.code });
  }

  finalize(path: string): Promise<FileFinalizeOutcome> {
    const file = this.#files.get(path);
    this.#files.set(path, { bytes: file?.bytes ?? new Uint8Array(0), finalized: true });
    return Promise.resolve({ kind: 'finalized' });
  }

  /** The append that would write line `line` (1-based) of `path` fails once with `effect`. */
  failWriteAt(path: string, line: number, effect: ScriptedFileWriteEffect, code = 'EIO'): void {
    if (!Number.isSafeInteger(line) || line < 1) {
      throw new RangeError(`line ${String(line)}; expected a positive safe integer`);
    }
    this.#faults.push({ path, line, effect, code });
  }

  /** Preloads raw bytes, for example a torn last line, without any check. */
  seedRaw(path: string, bytes: Uint8Array): void {
    this.#files.set(path, { bytes: bytes.slice(), finalized: false });
  }

  /** A copy of the bytes of `path`, or `undefined` when the file does not exist. */
  contents(path: string): Uint8Array | undefined {
    return this.#files.get(path)?.bytes.slice();
  }

  /** The bytes of `path` decoded as UTF-8, or `undefined` when the file does not exist. */
  text(path: string): string | undefined {
    const bytes = this.#files.get(path)?.bytes;
    return bytes === undefined ? undefined : decoder.decode(bytes);
  }

  isFinalized(path: string): boolean {
    return this.#files.get(path)?.finalized ?? false;
  }

  pendingFaultCount(): number {
    return this.#faults.length;
  }

  #takeFault(path: string, line: number): ScriptedFileFault | undefined {
    const index = this.#faults.findIndex((fault) => fault.path === path && fault.line === line);
    return index === -1 ? undefined : this.#faults.splice(index, 1)[0];
  }
}

function countLines(bytes: Uint8Array): number {
  return bytes.reduce((count, byte) => (byte === NEWLINE ? count + 1 : count), 0);
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.length + tail.length);
  joined.set(head, 0);
  joined.set(tail, head.length);
  return joined;
}
