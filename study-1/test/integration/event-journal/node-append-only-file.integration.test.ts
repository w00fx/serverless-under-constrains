// NodeAppendOnlyFile against the real file system (testing rule 2: file-system semantics are
// an integration boundary). Finalization survives the process as file mode 0444; open, read
// and directory failures are reported as `not_written`/`failed` with the OS code; a writer
// over the JSONL port produces a journal that the BR-RUA-033 JSONL parser reads back as dense,
// canonical events; and a restarted source instance keeps journaling after a torn write.

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

import type { Uuid4 } from '../../../src/record-contract/primitives.ts';

const RESTARTED_INSTANCE_ID = 'cccccccc-0000-4000-8000-000000000009' as Uuid4;
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

  it('a restarted instance appends after a torn write; the fragment stays its own malformed line', async () => {
    // BR-RUA-033: "After an ambiguous append result, that source instance stops emitting
    // events. A restart creates a new source instance." The torn bytes of the stopped instance
    // must neither block the new instance nor merge into its first record.
    const path = join(freshDirectory('torn-restart'), 'runner-journal.jsonl');
    const fragment = '{"schema_version":1,"record_type":"dispatch_sta';
    writeFileSync(path, fragment);
    const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
    const restarted = new JournalWriter({
      port: createJsonlJournalPort(path, new NodeAppendOnlyFile()),
      source: 'runner',
      instanceId: RESTARTED_INSTANCE_ID,
      scope: executionLevelScope(RUN, 'execution'),
      clock: time,
      ids: new SequentialUuidSource('88888888'),
      maxDefinitiveRetries: 1,
    });
    const first = appendedEvent(await restarted.append('dispatch_started', dispatchStartedBody(1)));
    const second = appendedEvent(await restarted.append('dispatch_started', dispatchStartedBody(2)));
    const text = readFileSync(path, 'utf8');
    assert.equal(
      text,
      `${fragment}\n${canonicalJson(first as unknown as JsonValue)}\n${canonicalJson(second as unknown as JsonValue)}\n`,
    );
    const report = parseJsonl(new Uint8Array(readFileSync(path)));
    assert.deepEqual(
      report.lines.map((line) => line.parsed.ok),
      [false, true, true],
    );
    assert.deepEqual([first.source_sequence, second.source_sequence], [1, 2]);
  });

  it('a file that is only a torn fragment gets exactly one separating newline', async () => {
    const path = join(freshDirectory('torn-only'), 'journal.jsonl');
    writeFileSync(path, 'x');
    const file = new NodeAppendOnlyFile();
    assert.deepEqual(await file.append(path, encoder.encode('a\n')), { kind: 'appended' });
    assert.deepEqual(await file.append(path, encoder.encode('b\n')), { kind: 'appended' });
    assert.equal(readFileSync(path, 'utf8'), 'x\na\nb\n');
  });
});
