// The append-only file port behind JSONL journals (runner, coordination, provisioning and
// cleanup journals, design §7). Production binds it to the local file system
// (`node/node-append-only-file.ts`, one fsync per line); tests bind it to `MemoryAppendOnlyFile`.
//
// Outcomes separate what is known about the bytes on disk, because BR-RUA-033 treats a
// definitive failure (retry identically) differently from an ambiguous one (stop the instance):
// - `appended`: every byte is written and flushed to stable storage;
// - `not_written`: no byte was written (for example the file is finalized, or cannot be opened);
// - `unknown`: some or all bytes may have been written (a write or flush failed midway).

export type FileAppendOutcome =
  | { readonly kind: 'appended' }
  | { readonly kind: 'not_written'; readonly code: string }
  | { readonly kind: 'unknown'; readonly code: string };

export type FileFinalizeOutcome = { readonly kind: 'finalized' } | { readonly kind: 'failed'; readonly code: string };

/** Codes every implementation uses for its own refusals, so callers see one vocabulary. */
export const APPEND_FILE_CODES = {
  /** The file was finalized; it accepts no more bytes. */
  finalized: 'FILE_FINALIZED',
  /** The file ends inside a line (an earlier write was torn); appending would merge two records. */
  tornTail: 'TORN_TAIL',
} as const;

export interface AppendOnlyFile {
  /** Appends `bytes` at the end of `path`, creating the file when it does not exist. */
  append(path: string, bytes: Uint8Array): Promise<FileAppendOutcome>;
  /** Makes `path` permanently read-only, creating it empty when absent; idempotent. */
  finalize(path: string): Promise<FileFinalizeOutcome>;
}
