// Conformance of RecordingAttemptStatePort (design §12.2): run differentially against the real
// `createDurableAttemptStatePort` over InMemoryItemStore. For any sequence of operations, with
// the faults both can inject (definitive failure, ambiguous applied or not), the two ports return
// the same outcomes, end with the same state item, and commit the same journal events. A
// property test covers the sequence space (testing rule 6: a state machine); runs FC_RUNS cases.
// The recorder's `throw` fault has no store counterpart: it emulates a defective port.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { toJournalEntry } from '../../../../src/event-journal/journal-entry.ts';
import { buildJournalEvent } from '../../../../src/event-journal/journal-event.ts';
import type { JournalEvent } from '../../../../src/event-journal/journal-event.ts';
import { journalItemKey } from '../../../../src/event-journal/journal-scope.ts';
import type { PreparedJournalPut } from '../../../../src/event-journal/journal-writer.ts';
import type { AttemptStatePort } from '../../../../src/provider-client/attempt-state-port.ts';
import { attemptStateSortKey } from '../../../../src/provider-client/attempt-state-port.ts';
import {
  ATTEMPT_STATE_TABLE,
  createDurableAttemptStatePort,
} from '../../../../src/provider-client/durable-attempt-state-port.ts';
import type { Uuid4 } from '../../../../src/record-contract/primitives.ts';
import { InMemoryItemStore } from '../../../support/durable-store/in-memory-item-store.ts';
import {
  ATTEMPT_ID,
  dispatchStartedBody,
  EPOCH_MS,
  EPOCH_UTC,
  INSTANCE_ID,
  PROVIDER_REQUEST_ID,
  TRIAL_SCOPE,
} from '../../../support/event-journal/journal-fixtures.ts';
import { fuzzParameters } from '../../../support/kernel/fuzz-parameters.ts';
import { VirtualTimeScheduler } from '../../../support/kernel/virtual-time-scheduler.ts';
import type { AttemptOperation } from '../../../support/provider-client/recording-attempt-state-port.ts';
import { RecordingAttemptStatePort } from '../../../support/provider-client/recording-attempt-state-port.ts';

type SharedFault =
  | { readonly kind: 'definitive_failure'; readonly code: string }
  | { readonly kind: 'ambiguous'; readonly code: string; readonly applied: boolean };

interface Step {
  readonly operation: AttemptOperation;
  readonly fault?: SharedFault;
}

interface PortUnderTest {
  readonly port: AttemptStatePort;
  readonly inject: (operation: AttemptOperation, fault: SharedFault) => void;
  readonly stateItem: () => Readonly<Record<string, unknown>> | undefined;
  readonly committed: () => readonly JournalEvent[];
}

function durablePort(): PortUnderTest {
  const store = new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
  return {
    port: createDurableAttemptStatePort(store),
    inject: (_operation, fault): void => {
      store.scriptWriteFault(fault, { operation: 'transact' });
    },
    stateItem: () => store.itemsIn(ATTEMPT_STATE_TABLE).find((item) => item.sk === attemptStateSortKey(ATTEMPT_ID)),
    committed: () =>
      store
        .itemsIn(ATTEMPT_STATE_TABLE)
        .filter((item) => !item.sk.startsWith('state#'))
        .map(({ pk: _pk, sk: _sk, ...event }) => event as unknown as JournalEvent)
        .sort((a, b) => a.source_sequence - b.source_sequence),
  };
}

function recordingPort(): PortUnderTest {
  const recorder = new RecordingAttemptStatePort();
  return {
    port: recorder,
    inject: (operation, fault): void => {
      recorder.scriptNext(operation, fault);
    },
    stateItem: () => recorder.stateItemOf(ATTEMPT_ID),
    committed: () => recorder.committedEvents(),
  };
}

// A fresh journal put per step; each put has its own key and event id, as a writer would make.
function putFor(sequence: number): PreparedJournalPut {
  const event = buildJournalEvent('dispatch_started', dispatchStartedBody(sequence), {
    scope: TRIAL_SCOPE,
    source: 'conventional_caller',
    source_instance_id: INSTANCE_ID,
    source_sequence: sequence,
    event_id: `ffffffff-0000-4000-8000-${String(sequence).padStart(12, '0')}` as Uuid4,
    occurred_at: EPOCH_UTC,
    causation: [],
  });
  return toJournalEntry(journalItemKey(TRIAL_SCOPE, 'conventional_caller', INSTANCE_ID, sequence), event);
}

function perform(port: AttemptStatePort, operation: AttemptOperation, put: PreparedJournalPut): Promise<unknown> {
  if (operation === 'registerPreDispatch') {
    return port.registerPreDispatch(
      { attempt_id: ATTEMPT_ID, provider_request_id: PROVIDER_REQUEST_ID, refund_request_id: 'ref-poc-001' },
      put,
    );
  }
  return port[operation](ATTEMPT_ID, put);
}

async function assertSameBehavior(steps: readonly Step[]): Promise<void> {
  const real = durablePort();
  const fake = recordingPort();
  for (const [index, step] of steps.entries()) {
    const put = putFor(index + 1);
    if (step.fault !== undefined) {
      real.inject(step.operation, step.fault);
      fake.inject(step.operation, step.fault);
    }
    const expected = await perform(real.port, step.operation, put);
    const actual = await perform(fake.port, step.operation, put);
    assert.deepEqual(actual, expected, `step ${String(index)}: ${JSON.stringify(step)}`);
  }
  assert.deepEqual(fake.stateItem(), real.stateItem(), JSON.stringify(steps));
  assert.deepEqual(fake.committed(), real.committed(), JSON.stringify(steps));
}

const OPERATIONS: readonly AttemptOperation[] = [
  'registerPreDispatch',
  'transitionToDispatched',
  'transitionToNotDispatched',
];

describe('RecordingAttemptStatePort conformance', () => {
  it('matches the durable port on the lifecycle and on every refused transition', async () => {
    await assertSameBehavior([
      { operation: 'transitionToDispatched' },
      { operation: 'registerPreDispatch' },
      { operation: 'registerPreDispatch' },
      { operation: 'transitionToDispatched' },
      { operation: 'transitionToNotDispatched' },
      { operation: 'transitionToDispatched' },
    ]);
    await assertSameBehavior([{ operation: 'registerPreDispatch' }, { operation: 'transitionToNotDispatched' }]);
  });

  it('matches the durable port under definitive and ambiguous faults', async () => {
    await assertSameBehavior([
      { operation: 'registerPreDispatch', fault: { kind: 'definitive_failure', code: 'ThrottlingException' } },
      { operation: 'registerPreDispatch', fault: { kind: 'ambiguous', code: 'RequestTimeout', applied: true } },
      { operation: 'transitionToDispatched', fault: { kind: 'ambiguous', code: 'RequestTimeout', applied: false } },
      { operation: 'transitionToNotDispatched', fault: { kind: 'ambiguous', code: 'RequestTimeout', applied: true } },
      { operation: 'transitionToDispatched', fault: { kind: 'ambiguous', code: 'RequestTimeout', applied: true } },
    ]);
  });

  it('matches the durable port on any operation sequence with shared faults (property)', async () => {
    const fault = fc.oneof(
      fc.constant(undefined),
      fc.constant({ kind: 'definitive_failure', code: 'ThrottlingException' } as const),
      fc.boolean().map((applied) => ({ kind: 'ambiguous', code: 'RequestTimeout', applied }) as const),
    );
    const step = fc
      .tuple(fc.constantFrom(...OPERATIONS), fault)
      .map(([operation, injected]): Step => (injected === undefined ? { operation } : { operation, fault: injected }));
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 8 }), (steps) => assertSameBehavior(steps)),
      fuzzParameters(),
    );
  });

  it('its throw fault rejects without changing state, emulating a defective port', async () => {
    const recorder = new RecordingAttemptStatePort();
    recorder.scriptNext('transitionToDispatched', { kind: 'throw', error: new Error('port defect') });
    await perform(recorder, 'registerPreDispatch', putFor(1));
    await assert.rejects(perform(recorder, 'transitionToDispatched', putFor(2)), { message: 'port defect' });
    assert.equal(recorder.phaseOf(ATTEMPT_ID), 'PRE_DISPATCH');
    assert.deepEqual(
      recorder.calls().map((call) => [call.operation, call.outcome.kind]),
      [
        ['registerPreDispatch', 'applied'],
        ['transitionToDispatched', 'thrown'],
      ],
    );
  });
});
