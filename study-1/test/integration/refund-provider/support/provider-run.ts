// Drives the composed provider on virtual time: start a call that may wait at the barrier, and
// let another writer act at a precise point of the call by reacting to the journal item the
// provider just wrote (the emulator notifies listeners synchronously inside the write).

import type { StoredItem } from '../../../../src/durable-store/item-store-port.ts';
import type { EventRecordType } from '../../../../src/record-contract/record-types.ts';
import type { JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ProviderInvocationResult } from '../../../../src/refund-provider/refund-provider.ts';
import type { ScriptedWriteFault } from '../../../support/durable-store/in-memory-item-store.ts';
import type { ProviderHarness } from '../../../support/refund-provider/provider-fixtures.ts';

export interface RunningCall {
  readonly result: Promise<ProviderInvocationResult>;
  readonly settled: () => boolean;
}

/** Starts one invocation and lets it run until it waits on virtual time or ends. */
export async function startInvocation(harness: ProviderHarness, raw: JsonValue): Promise<RunningCall> {
  let done = false;
  const result = harness.provider.handle(raw);
  const markDone = (): void => {
    done = true;
  };
  result.then(markDone, markDone);
  await harness.time.advanceBy(0);
  return { result, settled: () => done };
}

/** Runs `react` once, right after the provider writes its first event of `type`. */
export function afterProviderEvent(harness: ProviderHarness, type: EventRecordType, react: () => void): void {
  const unsubscribe = harness.store.subscribe('experiment_journal', (change) => {
    if (change.event_name === 'INSERT' && change.new_image['record_type'] === type) {
      unsubscribe();
      react();
    }
  });
}

/** After the provider writes its first `type` event, the next journal writes fail with `fault`. */
export function failJournalWritesAfter(
  harness: ProviderHarness,
  type: EventRecordType,
  fault: ScriptedWriteFault,
  times = 1,
): void {
  afterProviderEvent(harness, type, () => {
    for (let attempt = 0; attempt < times; attempt += 1) {
      harness.store.scriptWriteFault(fault, { operation: 'write', table: 'experiment_journal' });
    }
  });
}

/** After the provider accepts a call, another writer consumes the armed treatment. */
export function consumeTreatmentOnAccept(harness: ProviderHarness, consumed: StoredItem): void {
  afterProviderEvent(harness, 'provider_call_accepted', () => {
    harness.store.seed('control', consumed);
  });
}
