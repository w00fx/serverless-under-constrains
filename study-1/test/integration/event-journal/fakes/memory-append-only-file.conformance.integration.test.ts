// Conformance of MemoryAppendOnlyFile (design §12.2, RK-17): the shared AppendOnlyFile suite
// runs against the real NodeAppendOnlyFile in a temporary directory and against the emulator,
// so the emulator cannot drift from the binding it replaces. The fault-injection cases check
// that each scripted fault produces the outcome class a real write failure would:
// `not_written` when nothing reached the file, `unknown` when bytes may have (Node fs docs,
// https://nodejs.org/docs/latest-v24.x/api/fs.html, `filehandle.write` and `filehandle.sync`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { NodeAppendOnlyFile } from '../../../../src/event-journal/node/node-append-only-file.ts';
import type { AppendOnlyFileUnderTest } from '../../../support/event-journal/append-only-file-conformance.ts';
import { describeAppendOnlyFileConformance } from '../../../support/event-journal/append-only-file-conformance.ts';
import { MemoryAppendOnlyFile } from '../../../support/event-journal/memory-append-only-file.ts';

const encoder = new TextEncoder();
const directories: string[] = [];

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describeAppendOnlyFileConformance('NodeAppendOnlyFile', (): AppendOnlyFileUnderTest => {
  const directory = mkdtempSync(join(tmpdir(), 'rua-append-only-'));
  directories.push(directory);
  return {
    file: new NodeAppendOnlyFile(),
    path: (name) => join(directory, name),
    read: async (path): Promise<Uint8Array | undefined> => {
      try {
        return new Uint8Array(await readFile(path));
      } catch {
        return undefined;
      }
    },
    seedRaw: (path, bytes) => writeFile(path, bytes),
  };
});

describeAppendOnlyFileConformance('MemoryAppendOnlyFile', (): AppendOnlyFileUnderTest => {
  const file = new MemoryAppendOnlyFile();
  return {
    file,
    path: (name) => `memory/${name}`,
    read: (path) => Promise.resolve(file.contents(path)),
    seedRaw: (path, bytes): Promise<void> => {
      file.seedRaw(path, bytes);
      return Promise.resolve();
    },
  };
});

describe('MemoryAppendOnlyFile fault injection', () => {
  it('nothing_written fails the append of that line once and writes nothing', async () => {
    const file = new MemoryAppendOnlyFile();
    file.failWriteAt('j', 2, 'nothing_written', 'EACCES');
    assert.deepEqual(await file.append('j', encoder.encode('1\n')), { kind: 'appended' });
    assert.deepEqual(await file.append('j', encoder.encode('2\n')), { kind: 'not_written', code: 'EACCES' });
    assert.equal(file.text('j'), '1\n');
    assert.deepEqual(await file.append('j', encoder.encode('2\n')), { kind: 'appended' });
    assert.equal(file.text('j'), '1\n2\n');
    assert.equal(file.pendingFaultCount(), 0);
  });

  it('torn_write leaves the first half of the line and reports an unknown fate', async () => {
    const file = new MemoryAppendOnlyFile();
    file.failWriteAt('j', 1, 'torn_write');
    assert.deepEqual(await file.append('j', encoder.encode('abcd\n')), { kind: 'unknown', code: 'EIO' });
    assert.equal(file.text('j'), 'ab');
    assert.deepEqual(await file.append('j', encoder.encode('e\n')), { kind: 'not_written', code: 'TORN_TAIL' });
  });

  it('written_unacknowledged writes every byte but reports an unknown fate', async () => {
    const file = new MemoryAppendOnlyFile();
    file.failWriteAt('j', 1, 'written_unacknowledged', 'EIO');
    assert.deepEqual(await file.append('j', encoder.encode('a\n')), { kind: 'unknown', code: 'EIO' });
    assert.equal(file.text('j'), 'a\n');
  });

  it('faults target one path and one line', async () => {
    const file = new MemoryAppendOnlyFile();
    file.failWriteAt('other', 1, 'nothing_written');
    file.failWriteAt('j', 3, 'nothing_written');
    assert.deepEqual(await file.append('j', encoder.encode('1\n')), { kind: 'appended' });
    assert.equal(file.pendingFaultCount(), 2);
  });

  it('refuses a line number that is not a positive safe integer', () => {
    const file = new MemoryAppendOnlyFile();
    assert.throws(() => {
      file.failWriteAt('j', 0, 'torn_write');
    }, /line 0; expected a positive safe integer/);
  });

  it('reports finalization and absence', async () => {
    const file = new MemoryAppendOnlyFile();
    assert.equal(file.isFinalized('j'), false);
    assert.equal(file.contents('j'), undefined);
    assert.equal(file.text('j'), undefined);
    await file.finalize('j');
    assert.equal(file.isFinalized('j'), true);
  });
});
