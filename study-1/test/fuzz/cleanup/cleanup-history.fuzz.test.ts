// Property targets `readCleanupHistory`, `CleanupJournal.record` and `upperSnakeCode` (testing
// rule 6: the cleanup journal is read back as untrusted input on every AC-RUA-011 re-run).
// - Totality (Owner amendment A-05): any bytes, any JSON lines, valid lines with one field
//   replaced by any JSON value, and nested towers yield a history and never a throw; findings
//   stay bounded, and a valid line of this execution is always accepted wherever it sits.
// - Round trip (the run-twice defect): whatever reasons a port hands cleanup, the line the
//   journal writes reads back as exactly one accepted action, so a succeeded step is never
//   re-run because its own line was unreadable.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { CleanupActionBody } from '../../../src/cleanup/cleanup-action-fold.ts';
import { MAX_HISTORY_FINDINGS, readCleanupHistory } from '../../../src/cleanup/cleanup-history.ts';
import { CleanupJournal } from '../../../src/cleanup/cleanup-journal.ts';
import { conformingReason, upperSnakeCode } from '../../../src/cleanup/reason-conformance.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import type { StructuredReason, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { EPOCH_MS, EXECUTION, MANIFEST_SHA } from '../../support/cleanup/cleanup-fixtures.ts';
import { cleanupValidator } from '../../support/cleanup/cleanup-harness.ts';
import type { TowerShape } from '../../support/kernel/deep-json.ts';
import { towerText } from '../../support/kernel/deep-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { MemoryAppendOnlyFile } from '../../support/event-journal/memory-append-only-file.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const PATH = 'cleanup/cleanup-journal.jsonl';
const EXPECTED = { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA };
const UPPER_SNAKE = /^[A-Z][A-Z0-9_]*$/;
const FINDING_CODES = new Set(['CLEANUP_HISTORY_LINE_SKIPPED', 'CLEANUP_HISTORY_FINDINGS_OMITTED']);
const encoder = new TextEncoder();

const STEP_START: CleanupActionBody = {
  step: 9,
  step_status: 'started',
  cleanup_mode: 'NORMAL',
  cleanup_induced: false,
  action: 'OWNED_RESOURCES_DELETE',
  reasons: [],
};

function journalOver(file: MemoryAppendOnlyFile): CleanupJournal {
  const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
  const writer = new JournalWriter({
    port: createJsonlJournalPort(PATH, file),
    source: 'cleanup',
    instanceId: 'cccccccc-0000-4000-8000-000000000001' as Uuid4,
    scope: { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA, partition: { kind: 'execution' } },
    clock: time,
    ids: new SequentialUuidSource('eeeeeeee'),
    maxDefinitiveRetries: 0,
  });
  return new CleanupJournal(writer, time);
}

/** One valid journal line of this execution, written by the real journal. */
async function validLine(): Promise<string> {
  const file = new MemoryAppendOnlyFile();
  await journalOver(file).record(STEP_START);
  return (file.text(PATH) ?? '').trimEnd();
}

const VALID_LINE = await validLine();
const VALID_RECORD = JSON.parse(VALID_LINE) as Record<string, unknown>;

function history(bytes: Uint8Array): ReturnType<typeof readCleanupHistory> {
  return readCleanupHistory(bytes, EXPECTED, cleanupValidator());
}

function assertBoundedFindings(read: ReturnType<typeof readCleanupHistory>): void {
  assert.ok(read.findings.length <= MAX_HISTORY_FINDINGS + 1, `${String(read.findings.length)} findings`);
  for (const finding of read.findings) {
    assert.ok(FINDING_CODES.has(finding.code), finding.code);
    assert.equal(finding.subject, 'cleanup-journal.jsonl');
    assert.ok(finding.detail.length > 0);
  }
}

// Lines skipped: the listed findings plus the count the closing finding names.
function skippedLineCount(read: ReturnType<typeof readCleanupHistory>): number {
  const omitted = read.findings.find((finding) => finding.code === 'CLEANUP_HISTORY_FINDINGS_OMITTED');
  const listed = read.findings.length - (omitted === undefined ? 0 : 1);
  return listed + (omitted === undefined ? 0 : Number.parseInt(omitted.detail, 10));
}

// A line that is almost never a valid action: any text without a newline, any JSON value, a tower,
// or the valid record with one field replaced by any JSON value (inherited names included).
const fieldNames = fc.constantFrom(...Object.keys(VALID_RECORD), '__proto__', 'constructor', 'toString', 'extra');
const mutatedRecord = fc
  .tuple(fieldNames, fc.jsonValue())
  .filter(([name, value]) => JSON.stringify(VALID_RECORD[name]) !== JSON.stringify(value))
  .map(([name, value]) => {
    const text = JSON.stringify({ ...VALID_RECORD, [name]: value });
    // A spread drops `__proto__` as an own key; write it into the text instead.
    return name === '__proto__' ? `${text.slice(0, -1)},"__proto__":${JSON.stringify(value)}}` : text;
  });
const tower = fc
  .record({
    shape: fc.constantFrom<TowerShape>('array', 'object', 'mixed'),
    depth: fc.integer({ min: 1, max: 2_000 }),
  })
  .map(({ shape, depth }) => towerText(shape, depth, '1e999'));
const noiseLine = fc.oneof(
  fc.string({ unit: 'binary' }).map((text) => text.replaceAll('\n', ' ')),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  mutatedRecord,
  tower,
);

describe('readCleanupHistory properties', () => {
  it('is total over any bytes and bounds its findings', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 1_024 }), (bytes) => {
        const read = history(bytes);
        assert.equal(read.entries.length, 0, 'random bytes are never a valid action');
        assertBoundedFindings(read);
      }),
      fuzzParameters(),
    );
  });

  it('accepts every valid line among noise lines and accounts for every other line', () => {
    const lines = fc.array(fc.oneof(fc.constant(VALID_LINE), noiseLine), { maxLength: 40 });
    fc.assert(
      fc.property(lines, (chosen) => {
        const read = history(encoder.encode(chosen.map((line) => `${line}\n`).join('')));
        const valid = chosen.filter((line) => line === VALID_LINE).length;
        // A mutated record can still be a valid action (another valid enum value), so the valid
        // lines are a floor; every line is either an entry or a finding.
        assert.ok(
          read.entries.length >= valid,
          `${String(read.entries.length)} entries for ${String(valid)} valid lines`,
        );
        assert.ok(read.entries.every((entry) => entry.body.step >= 1 && entry.body.step <= 12));
        assertBoundedFindings(read);
        assert.equal(read.entries.length + skippedLineCount(read), chosen.length);
      }),
      fuzzParameters(),
    );
  });
});

const anyText = fc.string({ unit: 'binary', maxLength: 40 });
const anyReason: fc.Arbitrary<StructuredReason> = fc.record(
  {
    code: anyText,
    subject: anyText,
    detail: anyText,
    artifact_path: anyText,
    event_id: fc.oneof(fc.uuid({ version: 4 }), anyText),
  },
  { requiredKeys: ['code', 'subject', 'detail'] },
) as fc.Arbitrary<StructuredReason>;

describe('CleanupJournal round trip properties', () => {
  it('writes every action, whatever its reasons, as a line a re-run accepts', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(anyReason, { maxLength: 4 }), async (reasons) => {
        const file = new MemoryAppendOnlyFile();
        await journalOver(file).record({ ...STEP_START, reasons });
        const read = history(file.contents(PATH) ?? new Uint8Array());
        assert.deepEqual(read.findings, []);
        assert.deepEqual(read.entries[0]?.body.reasons, reasons.map(conformingReason));
      }),
      fuzzParameters(),
    );
  });
});

describe('upperSnakeCode properties', () => {
  it('always yields an UPPER_SNAKE code and keeps a conforming one', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (code) => {
        const snake = upperSnakeCode(code);
        assert.match(snake, UPPER_SNAKE);
        assert.equal(upperSnakeCode(snake), snake);
        if (UPPER_SNAKE.test(code)) {
          assert.equal(snake, code);
        }
      }),
      fuzzParameters(),
    );
  });
});
