// State-machine property of JournalWriter (testing rule 6; BR-RUA-033). For arbitrary
// interleavings of store faults, append counts and retry budgets, the writer behaves as a
// reference model written from the rule text: appends succeed with dense sequences from 1;
// a definitive failure is retried with the identical event until the budget runs out, which
// stops the instance; an ambiguous result stops it at once; a stopped instance never touches
// the medium again. The table medium scripts faults by write order (InMemoryItemStore), the
// JSONL medium by line number (MemoryAppendOnlyFile). A third property restarts the source
// after every ambiguous write: each new instance keeps journaling to the same JSONL file, and
// a torn fragment stays one malformed line, never merged into a record.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { AppendResult, JournalStopReason } from '../../../src/event-journal/journal-append-port.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { createJsonlJournalPort } from '../../../src/event-journal/jsonl-journal-port.ts';
import { parseJsonl } from '../../../src/record-contract/parsing.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { MemoryAppendOnlyFile } from '../../support/event-journal/memory-append-only-file.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import {
  dispatchStartedBody,
  EPOCH_MS,
  JSONL_PATH,
  TRIAL_SCOPE,
  writerHarness,
} from '../../support/event-journal/journal-fixtures.ts';
import type { WriterHarness } from '../../support/event-journal/journal-fixtures.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

type Fault = 'definitive' | 'ambiguous_applied' | 'ambiguous_lost';
type ModelResult = number | JournalStopReason;

interface ModelRun {
  readonly results: readonly ModelResult[];
  /** Sequences whose event reached the medium, in order. */
  readonly stored: readonly number[];
  /** Medium calls per sequence. */
  readonly calls: readonly number[];
}

// Reference model: `faultAt(sequence, attempt)` is the fault the medium injects into that write.
function model(
  appends: number,
  maxRetries: number,
  faultAt: (sequence: number, attempt: number) => Fault | undefined,
): ModelRun {
  const results: ModelResult[] = [];
  const stored: number[] = [];
  const calls: number[] = [];
  let sequence = 1;
  let stopped = false;
  for (let index = 0; index < appends; index += 1) {
    if (stopped) {
      results.push('INSTANCE_ALREADY_STOPPED');
      continue;
    }
    const outcome = writeOne(sequence, maxRetries, faultAt);
    calls.push(outcome.calls);
    if (outcome.stored) {
      stored.push(sequence);
    }
    results.push(outcome.result);
    stopped = outcome.result !== sequence;
    sequence += outcome.result === sequence ? 1 : 0;
  }
  return { results, stored, calls };
}

function writeOne(
  sequence: number,
  maxRetries: number,
  faultAt: (sequence: number, attempt: number) => Fault | undefined,
): { readonly result: ModelResult; readonly stored: boolean; readonly calls: number } {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const fault = faultAt(sequence, attempt);
    if (fault === undefined) {
      return { result: sequence, stored: true, calls: attempt + 1 };
    }
    if (fault !== 'definitive') {
      return { result: 'AMBIGUOUS_APPEND', stored: fault === 'ambiguous_applied', calls: attempt + 1 };
    }
  }
  return { result: 'DEFINITIVE_RETRIES_EXHAUSTED', stored: false, calls: maxRetries + 1 };
}

function observed(results: readonly AppendResult[]): readonly ModelResult[] {
  return results.map((result) => (result.kind === 'appended' ? result.event.source_sequence : result.reason));
}

async function runAppends(
  harness: WriterHarness,
  appends: number,
  concurrent: boolean,
): Promise<readonly AppendResult[]> {
  const bodies = Array.from({ length: appends }, (_, index) => dispatchStartedBody(index + 1));
  if (concurrent) {
    return Promise.all(bodies.map((body) => harness.writer.append('dispatch_started', body)));
  }
  const results: AppendResult[] = [];
  for (const body of bodies) {
    results.push(await harness.writer.append('dispatch_started', body));
  }
  return results;
}

function assertIdenticalRetries(harness: WriterHarness, expected: ModelRun): void {
  const bySequence = Map.groupBy(harness.port.entries(), (entry) => entry.event.source_sequence);
  assert.deepEqual(
    [...bySequence.values()].map((entries) => entries.length),
    expected.calls,
  );
  for (const entries of bySequence.values()) {
    entries.forEach((entry) => {
      assert.deepEqual(entry, entries[0]);
    });
  }
}

const faultArbitrary = fc.constantFrom<Fault>('definitive', 'ambiguous_applied', 'ambiguous_lost');
const scenario = fc.record({
  appends: fc.integer({ min: 1, max: 12 }),
  maxRetries: fc.integer({ min: 0, max: 3 }),
  concurrent: fc.boolean(),
});

describe('JournalWriter state machine', () => {
  it('over a journal table, matches the BR-RUA-033 model for faults scripted before each append', async () => {
    const appendFaults = fc.array(fc.array(faultArbitrary, { maxLength: 4 }), { minLength: 1, maxLength: 12 });
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 3 }), appendFaults, async (maxRetries, faultsByAppend) => {
        const harness = writerHarness({ maxDefinitiveRetries: maxRetries });
        const expected = model(
          faultsByAppend.length,
          maxRetries,
          (sequence, attempt) => faultsByAppend[sequence - 1]?.[attempt],
        );
        // The store consumes faults in write order, so each append's faults are scripted just
        // before it runs; appends therefore run one after another here.
        const results: AppendResult[] = [];
        for (const [index, faults] of faultsByAppend.entries()) {
          faults.forEach((fault) => {
            harness.store.scriptWriteFault(storeFault(fault));
          });
          results.push(await harness.writer.append('dispatch_started', dispatchStartedBody(index + 1)));
        }
        assert.deepEqual(observed(results), expected.results);
        assert.deepEqual(
          harness.store.itemsIn('caller_journal').map((item) => item['source_sequence']),
          expected.stored,
        );
        assertIdenticalRetries(harness, expected);
      }),
      fuzzParameters(),
    );
  });

  it('over a JSONL file, matches the model for faults by line and leaves only whole lines before a stop', async () => {
    const lineFaults = fc.array(fc.array(fileFault(), { maxLength: 4 }), { maxLength: 12 });
    await fc.assert(
      fc.asyncProperty(scenario, lineFaults, async (s, faultsByLine) => {
        const harness = writerHarness({ medium: 'jsonl', maxDefinitiveRetries: s.maxRetries });
        faultsByLine.forEach((faults, index) => {
          faults.forEach((fault) => {
            harness.file.failWriteAt(JSONL_PATH, index + 1, fault);
          });
        });
        const expected = model(s.appends, s.maxRetries, (sequence, attempt) =>
          modelFault(faultsByLine[sequence - 1]?.[attempt]),
        );
        const results = await runAppends(harness, s.appends, s.concurrent);
        assert.deepEqual(observed(results), expected.results);
        assertIdenticalRetries(harness, expected);
        const appendedCount = expected.results.filter((result) => typeof result === 'number').length;
        const report = parseJsonl(harness.file.contents(JSONL_PATH) ?? new Uint8Array(0));
        const wholeLines = report.lines.filter((line) => line.parsed.ok).length;
        assert.ok(wholeLines === appendedCount || wholeLines === appendedCount + 1);
      }),
      fuzzParameters(),
    );
  });
});

type LastWrite = 'whole' | 'torn_write' | 'written_unacknowledged';

interface InstancePlan {
  /** Appends before the last one, all whole. */
  readonly leading: number;
  /** The fate of the instance's last append; any fault stops the instance (ambiguous). */
  readonly last: LastWrite;
}

const NEWLINE = 0x0a;

// The line the next record lands on: a torn fragment counts as its own line
// (MemoryAppendOnlyFile.failWriteAt contract).
function nextRecordLine(bytes: Uint8Array): number {
  const newlines = bytes.reduce((count, byte) => (byte === NEWLINE ? count + 1 : count), 0);
  const torn = bytes.length > 0 && bytes[bytes.length - 1] !== NEWLINE;
  return newlines + (torn ? 2 : 1);
}

function instanceId(index: number): Uuid4 {
  return `cccccccc-0000-4000-8000-${String(index + 1).padStart(12, '0')}` as Uuid4;
}

async function runInstance(
  file: MemoryAppendOnlyFile,
  time: VirtualTimeScheduler,
  index: number,
  plan: InstancePlan,
): Promise<readonly AppendResult[]> {
  const writer = new JournalWriter({
    port: createJsonlJournalPort(JSONL_PATH, file),
    source: 'runner',
    instanceId: instanceId(index),
    scope: TRIAL_SCOPE,
    clock: time,
    ids: new SequentialUuidSource(String(index + 1).padStart(8, '0')),
    maxDefinitiveRetries: 0,
  });
  const results: AppendResult[] = [];
  for (let n = 1; n <= plan.leading + 1; n += 1) {
    if (n === plan.leading + 1 && plan.last !== 'whole') {
      file.failWriteAt(JSONL_PATH, nextRecordLine(file.contents(JSONL_PATH) ?? new Uint8Array(0)), plan.last);
    }
    results.push(await writer.append('dispatch_started', dispatchStartedBody(n)));
  }
  return results;
}

function expectedResults(plan: InstancePlan): readonly ModelResult[] {
  const leading = Array.from({ length: plan.leading }, (_, index) => index + 1);
  return [...leading, plan.last === 'whole' ? plan.leading + 1 : 'AMBIGUOUS_APPEND'];
}

describe('JournalWriter restarts over one JSONL file', () => {
  it('every restarted instance keeps journaling after an ambiguous write, and fragments stay apart', async () => {
    const plans = fc.array(
      fc.record({
        leading: fc.integer({ min: 0, max: 3 }),
        last: fc.constantFrom<LastWrite>('whole', 'torn_write', 'written_unacknowledged'),
      }),
      { minLength: 1, maxLength: 6 },
    );
    await fc.assert(
      fc.asyncProperty(plans, async (instances) => {
        const file = new MemoryAppendOnlyFile();
        const time = new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS });
        for (const [index, plan] of instances.entries()) {
          assert.deepEqual(observed(await runInstance(file, time, index, plan)), expectedResults(plan));
        }
        const report = parseJsonl(file.contents(JSONL_PATH) ?? new Uint8Array(0));
        const malformed = report.lines.filter((line) => !line.parsed.ok).length;
        assert.equal(malformed, instances.filter((plan) => plan.last === 'torn_write').length);
        assert.equal(report.ends_with_newline, instances.at(-1)?.last !== 'torn_write');
        // Whole lines, grouped by instance, hold that instance's dense sequences from 1.
        const sequences = new Map<string, number[]>();
        for (const line of report.lines) {
          if (line.parsed.ok) {
            const event = line.parsed.value as { source_instance_id: string; source_sequence: number };
            sequences.set(event.source_instance_id, [
              ...(sequences.get(event.source_instance_id) ?? []),
              event.source_sequence,
            ]);
          }
        }
        instances.forEach((plan, index) => {
          const stored = plan.leading + (plan.last === 'torn_write' ? 0 : 1);
          const expected = Array.from({ length: stored }, (_, n) => n + 1);
          assert.deepEqual(sequences.get(instanceId(index)) ?? [], expected);
        });
      }),
      fuzzParameters(),
    );
  });
});

function storeFault(fault: Fault): Parameters<WriterHarness['store']['scriptWriteFault']>[0] {
  return fault === 'definitive'
    ? { kind: 'definitive_failure', code: 'ThrottlingException' }
    : { kind: 'ambiguous', code: 'TimeoutError', applied: fault === 'ambiguous_applied' };
}

function fileFault(): fc.Arbitrary<'nothing_written' | 'torn_write' | 'written_unacknowledged'> {
  return fc.constantFrom('nothing_written', 'torn_write', 'written_unacknowledged');
}

function modelFault(
  effect: 'nothing_written' | 'torn_write' | 'written_unacknowledged' | undefined,
): Fault | undefined {
  if (effect === undefined) {
    return undefined;
  }
  return effect === 'nothing_written' ? 'definitive' : 'ambiguous_applied';
}
