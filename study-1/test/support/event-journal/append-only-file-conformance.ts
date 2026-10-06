// The AppendOnlyFile conformance suite (design §12.2, RK-17). It runs unchanged against the
// file-system binding `NodeAppendOnlyFile` in a temporary directory and against the
// `MemoryAppendOnlyFile` emulator, so the emulator is held to the behavior of the real binding:
// creation on first append, call-order accumulation, finalized-file refusal, idempotent
// finalization that creates an absent file, and a torn last line closed by its own newline.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AppendOnlyFile } from '../../../src/event-journal/append-only-file.ts';

export interface AppendOnlyFileUnderTest {
  readonly file: AppendOnlyFile;
  /** A fresh path in the implementation's namespace. */
  path(name: string): string;
  /** The bytes at `path`, or `undefined` when no file exists there. */
  read(path: string): Promise<Uint8Array | undefined>;
  /** Writes raw bytes without any check, for example a torn last line. */
  seedRaw(path: string, bytes: Uint8Array): Promise<void>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function text(subject: AppendOnlyFileUnderTest, path: string): Promise<string | undefined> {
  const bytes = await subject.read(path);
  return bytes === undefined ? undefined : decoder.decode(bytes);
}

/**
 * Declares the conformance cases for one implementation.
 *
 * @example
 * describeAppendOnlyFileConformance('MemoryAppendOnlyFile', () => memorySubject());
 */
export function describeAppendOnlyFileConformance(name: string, subjectFactory: () => AppendOnlyFileUnderTest): void {
  describe(`${name} conforms to the AppendOnlyFile contract`, () => {
    it('creates the file on first append with exactly the appended bytes', async () => {
      const subject = subjectFactory();
      const path = subject.path('created.jsonl');
      assert.equal(await subject.read(path), undefined);
      assert.deepEqual(await subject.file.append(path, encoder.encode('{"a":1}\n')), { kind: 'appended' });
      assert.equal(await text(subject, path), '{"a":1}\n');
    });

    it('accumulates appends in call order, including appends issued concurrently', async () => {
      const subject = subjectFactory();
      const path = subject.path('ordered.jsonl');
      const outcomes = await Promise.all(
        ['1', '2', '3'].map((n) => subject.file.append(path, encoder.encode(`${n}\n`))),
      );
      assert.deepEqual(outcomes, [{ kind: 'appended' }, { kind: 'appended' }, { kind: 'appended' }]);
      assert.equal(await text(subject, path), '1\n2\n3\n');
    });

    it('refuses every append to a finalized file without writing', async () => {
      const subject = subjectFactory();
      const path = subject.path('finalized.jsonl');
      await subject.file.append(path, encoder.encode('kept\n'));
      assert.deepEqual(await subject.file.finalize(path), { kind: 'finalized' });
      assert.deepEqual(await subject.file.append(path, encoder.encode('lost\n')), {
        kind: 'not_written',
        code: 'FILE_FINALIZED',
      });
      assert.equal(await text(subject, path), 'kept\n');
    });

    it('finalizes idempotently and creates an absent file empty', async () => {
      const subject = subjectFactory();
      const path = subject.path('empty.jsonl');
      assert.deepEqual(await subject.file.finalize(path), { kind: 'finalized' });
      assert.deepEqual(await subject.file.finalize(path), { kind: 'finalized' });
      assert.equal(await text(subject, path), '');
      assert.deepEqual(await subject.file.append(path, encoder.encode('x\n')), {
        kind: 'not_written',
        code: 'FILE_FINALIZED',
      });
    });

    it('closes a torn last line with its own newline before appending, and accepts an empty existing file', async () => {
      // BR-RUA-033: a restarted source instance keeps emitting after an earlier instance's torn
      // write; the fragment stays one malformed line and is never merged into the new record.
      const subject = subjectFactory();
      const torn = subject.path('torn.jsonl');
      await subject.seedRaw(torn, encoder.encode('{"a":1}\n{"b"'));
      assert.deepEqual(await subject.file.append(torn, encoder.encode('{"c":3}\n')), { kind: 'appended' });
      assert.equal(await text(subject, torn), '{"a":1}\n{"b"\n{"c":3}\n');
      assert.deepEqual(await subject.file.append(torn, encoder.encode('{"d":4}\n')), { kind: 'appended' });
      assert.equal(await text(subject, torn), '{"a":1}\n{"b"\n{"c":3}\n{"d":4}\n');
      const empty = subject.path('empty-existing.jsonl');
      await subject.seedRaw(empty, new Uint8Array(0));
      assert.deepEqual(await subject.file.append(empty, encoder.encode('ok\n')), { kind: 'appended' });
      assert.equal(await text(subject, empty), 'ok\n');
    });

    it('keeps paths independent', async () => {
      const subject = subjectFactory();
      const left = subject.path('left.jsonl');
      const right = subject.path('right.jsonl');
      await subject.file.append(left, encoder.encode('L\n'));
      await subject.file.finalize(left);
      assert.deepEqual(await subject.file.append(right, encoder.encode('R\n')), { kind: 'appended' });
      assert.equal(await text(subject, right), 'R\n');
    });
  });
}
