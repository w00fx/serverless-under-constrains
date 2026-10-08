// Reading the cleanup journal back (AC-RUA-011 re-runs): the bytes are untrusted, so the reader
// is total (Owner amendment A-05: 100,000-level nesting, non-finite numbers, inherited member
// names), accepts only valid actions of this execution and manifest whose resource action
// matches its basis, and bounds its findings.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CleanupActionBody } from '../../../src/cleanup/cleanup-action-fold.ts';
import { MAX_HISTORY_FINDINGS, readCleanupHistory } from '../../../src/cleanup/cleanup-history.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import type { ExecutionIdentity, Sha256Hex, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  EPOCH_MS,
  EXECUTION,
  EXECUTION_ID,
  MANIFEST_SHA,
  OTHER_EXECUTION_ID,
} from '../../support/cleanup/cleanup-fixtures.ts';
import { cleanupValidator } from '../../support/cleanup/cleanup-harness.ts';
import { MemoryAppendOnlyFile } from '../../support/event-journal/memory-append-only-file.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';

const PATH = 'cleanup/cleanup-journal.jsonl';
const EXPECTED = { execution: EXECUTION, execution_manifest_sha256: MANIFEST_SHA };
const encoder = new TextEncoder();

const STEP_START: CleanupActionBody = {
  step: 9,
  step_status: 'started',
  cleanup_mode: 'NORMAL',
  cleanup_induced: false,
  action: 'OWNED_RESOURCES_DELETE',
  reasons: [],
};
const DELETION: CleanupActionBody = {
  ...STEP_START,
  action: 'DELETED',
  resource_type: 'AWS::DynamoDB::Table',
  resource_identifier: 'suc1-aaaaaaaa-control',
  ownership_basis: 'resource_manifest_and_tags',
};

/** JSONL lines the real writer produces for `bodies`, one per line. */
async function journalLines(
  bodies: readonly CleanupActionBody[],
  execution: ExecutionIdentity = EXECUTION,
  manifest: Sha256Hex = MANIFEST_SHA,
): Promise<string[]> {
  const file = new MemoryAppendOnlyFile();
  const writer = new JournalWriter({
    port: createJsonlJournalPort(PATH, file),
    source: 'cleanup',
    instanceId: 'cccccccc-0000-4000-8000-000000000001' as Uuid4,
    scope: { execution, execution_manifest_sha256: manifest, partition: { kind: 'execution' } },
    clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }),
    ids: new SequentialUuidSource('eeeeeeee'),
    maxDefinitiveRetries: 0,
  });
  for (const body of bodies) {
    await writer.append('cleanup_action_recorded', body);
  }
  return (file.text(PATH) ?? '').split('\n').filter((line) => line.length > 0);
}

function read(lines: readonly string[], expected = EXPECTED): ReturnType<typeof readCleanupHistory> {
  return readCleanupHistory(encoder.encode(lines.map((line) => `${line}\n`).join('')), expected, cleanupValidator());
}

function findingDetails(history: ReturnType<typeof readCleanupHistory>): string[] {
  return history.findings.map((finding) => finding.detail);
}

describe('readCleanupHistory', () => {
  it('accepts valid actions of this execution, without envelope fields', async () => {
    const history = read(await journalLines([STEP_START, DELETION]));
    assert.deepEqual(history.findings, []);
    assert.deepEqual(
      history.entries.map((entry) => entry.body),
      [STEP_START, DELETION],
    );
    assert.equal(history.entries[0]?.occurred_at, '2026-10-05T12:00:00.000Z');
  });

  // Counterexample of the history fuzz property (FC seed 380123401, path 121:2:2): a line whose
  // field was rewritten to another schema-valid value is a valid action, not noise.
  it('accepts a cleanup-induced action, whatever value its valid fields hold', async () => {
    const induced = { ...STEP_START, cleanup_induced: true };
    const history = read(await journalLines([induced]));
    assert.deepEqual(history.findings, []);
    assert.deepEqual(
      history.entries.map((entry) => entry.body),
      [induced],
    );
  });

  it('reads an empty journal as no history', () => {
    assert.deepEqual(readCleanupHistory(new Uint8Array(), EXPECTED, cleanupValidator()), { entries: [], findings: [] });
  });

  it('skips actions of another execution, identity kind or manifest', async () => {
    const otherRun = await journalLines([STEP_START], { execution_kind: 'RUN', run_id: OTHER_EXECUTION_ID });
    const probe = await journalLines([STEP_START], {
      execution_kind: 'TRANSPORT_PROBE',
      transport_probe_id: EXECUTION_ID,
    });
    const validation = await journalLines([STEP_START], {
      execution_kind: 'VARIANT_VALIDATION',
      variant_validation_id: EXECUTION_ID,
    });
    const otherManifest = await journalLines([STEP_START], EXECUTION, 'b'.repeat(64) as Sha256Hex);
    const history = read([...otherRun, ...probe, ...validation, ...otherManifest]);
    assert.deepEqual(history.entries, []);
    assert.deepEqual(
      findingDetails(history).map((detail) => detail.split(';')[0]),
      [
        `line 1: recorded for run_id ${OTHER_EXECUTION_ID} with manifest ${MANIFEST_SHA} instead of run_id ${EXECUTION_ID} with manifest ${MANIFEST_SHA}`,
        `line 2: recorded for transport_probe_id ${EXECUTION_ID} with manifest ${MANIFEST_SHA} instead of run_id ${EXECUTION_ID} with manifest ${MANIFEST_SHA}`,
        `line 3: recorded for variant_validation_id ${EXECUTION_ID} with manifest ${MANIFEST_SHA} instead of run_id ${EXECUTION_ID} with manifest ${MANIFEST_SHA}`,
        `line 4: recorded for run_id ${EXECUTION_ID} with manifest ${'b'.repeat(64)} instead of run_id ${EXECUTION_ID} with manifest ${MANIFEST_SHA}`,
      ],
    );
    assert.ok(history.findings.every((finding) => finding.code === 'CLEANUP_HISTORY_LINE_SKIPPED'));
  });

  it('matches a probe history against a probe expectation', async () => {
    const probe: ExecutionIdentity = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: EXECUTION_ID };
    const history = read(await journalLines([STEP_START], probe), {
      execution: probe,
      execution_manifest_sha256: MANIFEST_SHA,
    });
    assert.equal(history.entries.length, 1);
  });

  it('skips a resource action whose basis contradicts it, or that has no basis', async () => {
    const lines = await journalLines([
      { ...DELETION, action: 'SKIPPED_AMBIGUOUS' },
      { ...DELETION, action: 'EXCLUDED_BASELINE', ownership_basis: 'ambiguous' },
      { ...DELETION, ownership_basis: 'excluded_baseline' },
      { ...STEP_START, action: 'DELETE_FAILED' },
      { ...DELETION, action: 'SKIPPED_AMBIGUOUS', ownership_basis: 'ambiguous' },
    ]);
    const history = read(lines);
    assert.equal(history.entries.length, 1);
    assert.deepEqual(
      findingDetails(history).map((detail) => detail.split(';')[0]),
      [
        'line 1: action SKIPPED_AMBIGUOUS with ownership_basis resource_manifest_and_tags',
        'line 2: action EXCLUDED_BASELINE with ownership_basis ambiguous',
        'line 3: action DELETED with ownership_basis excluded_baseline',
        'line 4: action DELETE_FAILED with ownership_basis absent',
      ],
    );
  });

  it('skips unparsable, invalid-UTF-8, schema-invalid and other-record lines', async () => {
    const [valid = ''] = await journalLines([STEP_START]);
    const text = ['{not json', '', 'null', valid.replace('"cleanup"', '"runner"'), '{"record_type":"payment"}'].join(
      '\n',
    );
    const withBadUtf8 = new Uint8Array([...encoder.encode(`${text}\n`), 0xc0, 0x80, 0x0a]);
    const history = readCleanupHistory(withBadUtf8, EXPECTED, cleanupValidator());
    assert.deepEqual(history.entries, []);
    const details = findingDetails(history);
    assert.equal(details.length, 6);
    assert.match(details[0] ?? '', /^line 1: unparsable/);
    assert.match(details[1] ?? '', /^line 2: unparsable/);
    assert.match(details[2] ?? '', /^line 3: invalid record/);
    assert.match(details[3] ?? '', /^line 4: invalid record \(\/source fails/);
    assert.match(details[4] ?? '', /^line 5: invalid record/);
    assert.match(details[5] ?? '', /^line 6: unparsable \(invalid UTF-8 at byte \d+\)/);
  });

  it('is total over 100,000-level nesting, non-finite numbers and inherited member names', async () => {
    const [valid = ''] = await journalLines([STEP_START]);
    const hostile = [
      towerText('array', DEEP_NESTING, '1'),
      towerText('object', DEEP_NESTING, 'null'),
      towerText('mixed', DEEP_NESTING, '"x"'),
      valid.replace('"step":9', '"step":1e999'),
      valid.replace('"step":9', '"step":-1e999'),
      valid.replace('{', '{"__proto__":{"step":1},'),
      valid.replace('{', '{"constructor":1,'),
      valid.replace('{', '{"toString":"x","hasOwnProperty":0,'),
    ];
    const history = read(hostile);
    assert.deepEqual(history.entries, []);
    assert.equal(history.findings.length, hostile.length);
    assert.ok(
      history.findings.every((finding) => finding.detail.length < 2_000),
      'bounded details',
    );
  });

  it('lists at most MAX_HISTORY_FINDINGS findings and counts the rest', () => {
    const lines = Array.from({ length: MAX_HISTORY_FINDINGS + 5 }, () => 'x');
    const history = read(lines);
    assert.equal(history.findings.length, MAX_HISTORY_FINDINGS + 1);
    assert.deepEqual(history.findings.at(-1), {
      code: 'CLEANUP_HISTORY_FINDINGS_OMITTED',
      subject: 'cleanup-journal.jsonl',
      detail: `5 further skipped lines are not listed; expected at most ${String(MAX_HISTORY_FINDINGS)} findings per read`,
    });
    assert.equal(read(lines.slice(0, MAX_HISTORY_FINDINGS)).findings.length, MAX_HISTORY_FINDINGS);
  });
});
