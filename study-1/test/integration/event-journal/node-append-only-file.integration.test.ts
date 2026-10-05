// NodeAppendOnlyFile against the real file system (testing rule 2: file-system semantics are
// an integration boundary). Finalization survives the process as file mode 0444; open, read
// and directory failures are reported as `not_written`/`failed` with the OS code; and a writer
// over the JSONL port produces a journal that the BR-RUA-033 JSONL parser reads back as dense,
// canonical events.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import { NodeAppendOnlyFile } from '../../../src/event-journal/node/node-append-only-file.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { parseJsonl } from '../../../src/record-contract/parsing.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  appendedEvent,
  dispatchStartedBody,
  EPOCH_MS,
  executionLevelScope,
  INSTANCE_ID,
  RUN,
} from '../../support/event-journal/journal-fixtures.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const encoder = new TextEncoder();
const root = mkdtempSync(join(tmpdir(), 'rua-node-append-'));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function freshDirectory(name: string): string {
  const directory = join(root, name);
  mkdirSync(directory);
  return directory;
}

describe('NodeAppendOnlyFile on the local file system', () => {
  it('finalization makes the file read-only on disk, and a new instance still refuses it', async () => {
    const path = join(freshDirectory('finalize'), 'journal.jsonl');
    const first = new NodeAppendOnlyFile();
    await first.append(path, encoder.encode('a\n'));
    assert.deepEqual(await first.finalize(path), { kind: 'finalized' });
    assert.equal(statSync(path).mode & 0o777, 0o444);
    assert.deepEqual(await new NodeAppendOnlyFile().append(path, encoder.encode('b\n')), {
      kind: 'not_written',
      code: 'FILE_FINALIZED',
    });
    assert.equal(readFileSync(path, 'utf8'), 'a\n');
  });

  it('a file made read-only outside the adapter is refused as finalized', async () => {
    const path = join(freshDirectory('external'), 'journal.jsonl');
    writeFileSync(path, 'x\n');
    chmodSync(path, 0o444);
    assert.deepEqual(await new NodeAppendOnlyFile().append(path, encoder.encode('y\n')), {
      kind: 'not_written',
      code: 'FILE_FINALIZED',
    });
  });

  it('reports a missing directory as not written, and as a failed finalization', async () => {
    const path = join(root, 'missing-directory', 'journal.jsonl');
    const file = new NodeAppendOnlyFile();
    assert.deepEqual(await file.append(path, encoder.encode('a\n')), { kind: 'not_written', code: 'ENOENT' });
    assert.deepEqual(await file.finalize(path), { kind: 'failed', code: 'ENOENT' });
  });

  it('reports a directory in place of the file as not written', async () => {
    const path = freshDirectory('is-a-directory');
    assert.deepEqual(await new NodeAppendOnlyFile().append(path, encoder.encode('a\n')), {
      kind: 'not_written',
      code: 'EISDIR',
    });
  });

  it('reports a path under a regular file as not written', async () => {
    const parent = join(freshDirectory('not-a-directory'), 'plain');
    writeFileSync(parent, '');
    const outcome = await new NodeAppendOnlyFile().append(join(parent, 'journal.jsonl'), encoder.encode('a\n'));
    assert.deepEqual(outcome, { kind: 'not_written', code: 'ENOTDIR' });
  });

  it('a writer over the JSONL port leaves dense canonical events that parse back', async () => {
    const path = join(freshDirectory('writer'), 'runner-journal.jsonl');
    const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
    const writer = new JournalWriter({
      port: createJsonlJournalPort(path, new NodeAppendOnlyFile()),
      source: 'probe_caller',
      instanceId: INSTANCE_ID,
      scope: executionLevelScope(RUN, 'probe'),
      clock: time,
      ids: new SequentialUuidSource('99999999'),
      maxDefinitiveRetries: 1,
    });
    const appended = [];
    for (const n of [1, 2, 3]) {
      appended.push(appendedEvent(await writer.append('dispatch_started', dispatchStartedBody(n))));
    }
    const bytes = new Uint8Array(readFileSync(path));
    const report = parseJsonl(bytes);
    assert.equal(report.ends_with_newline, true);
    assert.deepEqual(
      report.lines.map((line) =>
        line.parsed.ok ? (line.parsed.value as { source_sequence: number }).source_sequence : 0,
      ),
      [1, 2, 3],
    );
    const expected = appended.map((event) => `${canonicalJson(event as unknown as JsonValue)}\n`).join('');
    assert.equal(new TextDecoder().decode(bytes), expected);
  });
});
