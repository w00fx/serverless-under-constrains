// Conformance of ScriptedControllerStatePort: unscripted, it is the real port (same reads, same
// signal outcome on the same store state); each script changes only the call it names.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createControllerStatePort } from '../../../../src/treatment-controller/controller-state-port.ts';
import type { SignalTransition } from '../../../../src/treatment-controller/controller-state-port.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import { toJournalEntry } from '../../../../src/event-journal/journal-entry.ts';
import type { JournalEvent } from '../../../../src/event-journal/journal-event.ts';
import {
  ATTEMPT_ID,
  CALLER_EVENT_ID,
  PROBE_PK,
  committedTreatmentItem,
  probeConfigItem,
} from '../../../unit/treatment-controller/support/controller-fixtures.ts';
import { ScriptedControllerStatePort } from '../support/scripted-controller-state-port.ts';

const PARTITION = { kind: 'probe', key: PROBE_PK } as const;

function seededStore(): InMemoryItemStore {
  const store = new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: 0 }) });
  store.seed('control', probeConfigItem());
  store.seed('control', committedTreatmentItem(PROBE_PK));
  return store;
}

function transition(sequence: string): SignalTransition {
  const event = {
    record_type: 'timeout_signal_recorded',
    event_id: `f0000000-0000-4000-8000-00000000${sequence}`,
  } as unknown as JournalEvent;
  return {
    partition: PROBE_PK,
    attempt_id: ATTEMPT_ID,
    caller_timeout_event_id: CALLER_EVENT_ID,
    event: toJournalEntry({ pk: PROBE_PK, sk: `treatment_controller#x#00000000${sequence}` }, event),
    token: `f0000000-0000-4000-8000-00000001${sequence}` as SignalTransition['token'],
  };
}

describe('ScriptedControllerStatePort conformance', () => {
  it('unscripted, reads and signals exactly like the real port', async () => {
    const realStore = seededStore();
    const fakeStore = seededStore();
    const real = createControllerStatePort(realStore);
    const fake = new ScriptedControllerStatePort(createControllerStatePort(fakeStore));
    assert.deepEqual(await fake.loadConfiguration(PARTITION), await real.loadConfiguration(PARTITION));
    assert.deepEqual(await fake.loadTreatment(PARTITION), await real.loadTreatment(PARTITION));
    const realSignal = await real.signal(transition('0001'));
    assert.deepEqual(realSignal, { kind: 'applied' });
    assert.deepEqual(await fake.signal(transition('0001')), realSignal);
    assert.deepEqual(fakeStore.itemsIn('control'), realStore.itemsIn('control'));
    assert.deepEqual(fakeStore.itemsIn('experiment_journal'), realStore.itemsIn('experiment_journal'));
    const realRepeat = await real.signal(transition('0002'));
    assert.equal(realRepeat.kind, 'condition_failed');
    assert.deepEqual(await fake.signal(transition('0002')), realRepeat);
    assert.equal(fake.transitions().length, 2);
  });

  it('scripts change only the next call they name', async () => {
    const store = seededStore();
    const fake = new ScriptedControllerStatePort(createControllerStatePort(store));
    fake.failNextTreatmentRead({ code: 'X', detail: 'scripted' });
    assert.deepEqual(await fake.loadTreatment(PARTITION), { ok: false, error: { code: 'X', detail: 'scripted' } });
    assert.equal((await fake.loadTreatment(PARTITION)).ok, true);
    fake.answerNextSignal({ kind: 'ambiguous', code: 'TimeoutError' });
    assert.deepEqual(await fake.signal(transition('0003')), { kind: 'ambiguous', code: 'TimeoutError' });
    assert.equal(store.peek('control', { pk: PROBE_PK, sk: 'treatment' })?.['state'], 'COMMITTED_WAITING');
    let ran = false;
    fake.beforeNextSignal(() => {
      ran = true;
      return Promise.resolve();
    });
    assert.deepEqual(await fake.signal(transition('0004')), { kind: 'applied' });
    assert.ok(ran);
  });
});
