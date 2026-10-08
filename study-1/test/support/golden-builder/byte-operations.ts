// Byte-level scenario operations, applied after serialization: faults that exist only as bytes
// (a missing artifact, invalid UTF-8, a truncated document, a trailing partial line), and edits
// made after every digest was computed, so the digests other files hold no longer match (a
// core-file digest mismatch, BR-RUA-034). Every operation returns a result naming the offending
// value and the expected shape instead of throwing.

import { boundedJsonText } from '../../../src/record-contract/json-value.ts';
import { classifyArtifactPath } from '../../../src/record-contract/evidence-refs.ts';
import type { Result } from '../../../src/record-contract/primitives.ts';
import type { FixtureBytes } from './digest-links.ts';
import { expandSubjectAlias } from './scenario-operations.ts';

export type ByteOperation =
  | { readonly op: 'delete_file'; readonly path: string }
  | { readonly op: 'corrupt_byte'; readonly path: string; readonly offset: number; readonly byte: number }
  | { readonly op: 'append_text'; readonly path: string; readonly text: string }
  | { readonly op: 'truncate'; readonly path: string; readonly length: number };

export const BYTE_OPERATION_NAMES = ['delete_file', 'corrupt_byte', 'append_text', 'truncate'] as const;

const encoder = new TextEncoder();

/**
 * Applies byte operations in order to a copy of the serialized files; the first failing operation
 * stops the run and is reported with its position.
 *
 * @example
 * applyByteOperations(bytes, [{ op: 'corrupt_byte', path: '$trial/inputs/payment.json', offset: 0, byte: 0xff }], 'trials/t');
 */
export function applyByteOperations(
  bytes: FixtureBytes,
  operations: readonly ByteOperation[],
  subjectDirectory: string,
): Result<FixtureBytes, string> {
  const edited = new Map(bytes);
  for (const [index, operation] of operations.entries()) {
    const path = expandSubjectAlias(operation.path, subjectDirectory);
    const applied = applyOne(edited, { ...operation, path });
    if (!applied.ok) {
      return { ok: false, error: `byte operation ${String(index + 1)} (${operation.op}): ${applied.error}` };
    }
  }
  return { ok: true, value: edited };
}

function applyOne(files: Map<string, Uint8Array>, operation: ByteOperation): Result<null, string> {
  const violation = classifyArtifactPath(operation.path);
  if (violation !== undefined) {
    return {
      ok: false,
      error: `path ${boundedJsonText(operation.path)} is ${violation}; expected a normalized package-relative path`,
    };
  }
  const current = files.get(operation.path);
  if (current === undefined) {
    return {
      ok: false,
      error: `the scenario holds no file ${boundedJsonText(operation.path)}; expected an existing fixture file`,
    };
  }
  const edited = editBytes(current, operation);
  if (!edited.ok) {
    return edited;
  }
  if (edited.value === undefined) {
    files.delete(operation.path);
  } else {
    files.set(operation.path, edited.value);
  }
  return { ok: true, value: null };
}

// `undefined` deletes the file.
function editBytes(current: Uint8Array, operation: ByteOperation): Result<Uint8Array | undefined, string> {
  switch (operation.op) {
    case 'delete_file':
      return { ok: true, value: undefined };
    case 'corrupt_byte':
      return corruptByte(current, operation.offset, operation.byte);
    case 'append_text': {
      const appended = new Uint8Array(current.length + encoder.encode(operation.text).length);
      appended.set(current);
      appended.set(encoder.encode(operation.text), current.length);
      return { ok: true, value: appended };
    }
    case 'truncate':
      return isIndex(operation.length, current.length + 1)
        ? { ok: true, value: current.slice(0, operation.length) }
        : {
            ok: false,
            error: `length ${String(operation.length)}; expected an integer in 0..${String(current.length)}`,
          };
  }
}

function corruptByte(current: Uint8Array, offset: number, byte: number): Result<Uint8Array, string> {
  if (!isIndex(offset, current.length)) {
    return { ok: false, error: `offset ${String(offset)}; expected an integer in 0..${String(current.length - 1)}` };
  }
  if (!isIndex(byte, 256)) {
    return { ok: false, error: `byte ${String(byte)}; expected an integer in 0..255` };
  }
  const corrupted = current.slice();
  corrupted[offset] = byte;
  return { ok: true, value: corrupted };
}

function isIndex(value: number, limit: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value < limit;
}
