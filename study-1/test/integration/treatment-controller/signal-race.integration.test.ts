// "A failed signal condition re-reads ALL_OLD and re-decides once" (design §9.11): the treatment
// changed between the controller's read and its signal transaction. The race is reproduced on
// the real store by another writer's conditional update; outcomes the emulator cannot produce on
// demand are scripted at the port.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { createDurableJournalPort } from '../../../src/event-journal/durable-journal-port.ts';
import { JournalWriter } from '../../../src/event-journal/journal-writer.ts';
import { RecordingJournalAppendPort } from '../../support/event-journal/recording-journal-append-port.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import {
  CALLER_EVENT_ID,
  MANIFEST_SHA,
  OTHER_CALLER_EVENT_ID,
  PROBE,
  PROBE_PK,
  assertSchemaValid,
  callerTimeoutImage,
  committedTreatmentItem,
  probeConfigItem,
  streamInsert,
} from '../../unit/treatment-controller/support/controller-fixtures.ts';
import { scriptedControllerHarness } from './support/controller-integration-fixtures.ts';
import type { ScriptedControllerHarness } from './support/controller-integration-fixtures.ts';

const TREATMENT_KEY = { pk: PROBE_PK, sk: 'treatment' } as const;

function racingHarness(): ScriptedControllerHarness {
  const harness = scriptedControllerHarness(PROBE);
  harness.store.seed('control', probeConfigItem());
  harness.store.seed('control', committedTreatmentItem(PROBE_PK));
  return harness;
}

async function concurrentUpdate(harness: ScriptedControllerHarness, set: JsonObject): Promise<void> {
  const outcome = await harness.store.write({
    kind: 'update',
    table: 'control',
    key: TREATMENT_KEY,
    set,
    increment: { version: 1 },
    condition: { kind: 'attribute_equals', name: 'state', value: 'COMMITTED_WAITING' },
  });
  assert.equal(outcome.kind, 'applied');
}

function journalTypes(harness: ScriptedControllerHarness): readonly string[] {
  return harness.store.itemsIn('experiment_journal').map((item) => {
    const type = item['record_type'];
    return typeof type === 'string' ? type : JSON.stringify(type);
  });
}

describe('signal condition failure: re-read ALL_OLD and re-decide once', () => {
  it('a safety release won the race: late_rejected, written at the freed sequence', async () => {
    const harness = racingHarness();
    harness.state.beforeNextSignal(() =>
      concurrentUpdate(harness, { state: 'SAFETY_RELEASED', safety_release_cause: 'SAFETY_DEADLINE' }),
    );
    const result = await harness.controller.handle(streamInsert(callerTimeoutImage('probe')));
    assert.equal(result.outcome, 'late_rejected');
    assert.deepEqual(journalTypes(harness), ['late_timeout_signal_rejected']);
    const [late] = harness.store.itemsIn('experiment_journal');
    assert.equal(late?.['source_sequence'], 1);
    assertSchemaValid(harness.store.itemsIn('experiment_journal').map(({ pk: _pk, sk: _sk, ...event }) => event));
    assert.equal(harness.store.peek('control', TREATMENT_KEY)?.['state'], 'SAFETY_RELEASED');
  });

  it('another caller event signalled first: conflict naming it', async () => {
    const harness = racingHarness();
    harness.state.beforeNextSignal(() =>
      concurrentUpdate(harness, {
        state: 'TIMEOUT_SIGNALLED',
        signal_event_id: 'f0000000-0000-4000-8000-0000000000aa',
        signal_caller_event_id: OTHER_CALLER_EVENT_ID,
      }),
    );
    const result = await harness.controller.handle(streamInsert(callerTimeoutImage('probe')));
    assert.equal(result.outcome, 'conflict');
    const [conflict] = harness.store.itemsIn('experiment_journal');
    assert.equal(conflict?.['existing_caller_event_id'], OTHER_CALLER_EVENT_ID);
    assert.equal(conflict['caller_timeout_event_id'], CALLER_EVENT_ID);
  });

  it('the treatment item vanished: invalid_event_rejected (no treatment item)', async () => {
    const harness = racingHarness();
    harness.state.answerNextSignal({ kind: 'condition_failed', failed_action_index: 0 });
    const result = await harness.controller.handle(streamInsert(callerTimeoutImage('probe')));
    assert.equal(result.outcome, 'invalid_event_rejected');
    assert.deepEqual(journalTypes(harness), ['caller_timeout_rejected']);
  });

  it('ALL_OLD cannot be decoded: STATE_UNREADABLE', async () => {
    const harness = racingHarness();
    harness.state.answerNextSignal({
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { ...TREATMENT_KEY, state: 'COMMITTED_WAITING', version: 3 },
    });
    await assert.rejects(harness.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'STATE_UNREADABLE',
    });
    assert.deepEqual(journalTypes(harness), []);
  });

  it('ALL_OLD still admits the signal: SIGNAL_REDECIDED_TO_SIGNAL instead of a second attempt', async () => {
    const harness = racingHarness();
    harness.state.answerNextSignal({
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: committedTreatmentItem(PROBE_PK),
    });
    await assert.rejects(harness.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'SIGNAL_REDECIDED_TO_SIGNAL',
      message: `SIGNAL_REDECIDED_TO_SIGNAL: treatment condition failed but ALL_OLD still admits the signal for ${CALLER_EVENT_ID}; expected a changed treatment`,
    });
    assert.equal(harness.state.transitions().length, 1);
  });

  it('the journal put failed its condition: a sequence conflict stops the instance, JOURNAL_STOPPED', async () => {
    // A failed item_absent condition on the signal record's own put (index 1) proves another
    // event occupies its key, even without an ALL_OLD item (WP-05 review round 2).
    const harness = racingHarness();
    harness.state.answerNextSignal({ kind: 'condition_failed', failed_action_index: 1 });
    await assert.rejects(harness.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'JOURNAL_STOPPED',
      message: 'JOURNAL_STOPPED: signal transaction SEQUENCE_CONFLICT; expected applied',
    });
  });
});

describe('a journal instance that already stopped', () => {
  it('cannot prepare the signal record: JOURNAL_STOPPED before any transaction', async () => {
    const ids = new SequentialUuidSource('eeeeeeee');
    const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12, 0, 3) });
    const port = new RecordingJournalAppendPort(
      createDurableJournalPort(new InMemoryItemStore({ clock: time }), 'experiment_journal'),
    );
    const stopped = new JournalWriter({
      port,
      source: 'treatment_controller',
      instanceId: ids.next(),
      scope: { execution: PROBE, execution_manifest_sha256: MANIFEST_SHA, partition: { kind: 'probe' } },
      clock: time,
      ids,
      maxDefinitiveRetries: 0,
    });
    port.throwNext(new Error('socket hang up'));
    assert.equal(
      (await stopped.append('controller_canary_acknowledged', { canary_event_id: CALLER_EVENT_ID })).kind,
      'stopped',
    );

    const harness = scriptedControllerHarness(PROBE, () => stopped);
    harness.store.seed('control', probeConfigItem());
    harness.store.seed('control', committedTreatmentItem(PROBE_PK));
    await assert.rejects(harness.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'JOURNAL_STOPPED',
      message: 'JOURNAL_STOPPED: signal record not prepared: INSTANCE_ALREADY_STOPPED',
    });
    assert.equal(harness.state.transitions().length, 0);
  });
});
