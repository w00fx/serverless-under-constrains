// The composed probe caller over the InMemoryItemStore emulator and the ScriptedProviderInvoker
// (BR-RUA-027, BR-RUA-028): one recorded invocation start, exactly one attempt through the shared
// provider client caused by it, no retry, and faults before any provider call.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import type { ProbeWorkloadReport } from '../../../src/transport-probe-caller/probe-caller.ts';
import { composeProbeCaller } from '../../../src/transport-probe-caller/probe-caller-composition.ts';
import type { ProbeCaller } from '../../../src/transport-probe-caller/probe-caller.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import {
  PROVIDER_QUALIFIER,
  succeededResponder,
  transportError,
} from '../../support/provider-client/provider-client-fixtures.ts';
import { ScriptedProviderInvoker } from '../../support/provider-client/scripted-provider-invoker.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { PROBE, PROBE_PK, RUN, workloadRequest } from '../../unit/transport-probe-caller/support/probe-fixtures.ts';
import { nestedArrays } from '../../support/transport-rehearsal/deep-values.ts';

interface ProbeHarness {
  readonly store: InMemoryItemStore;
  readonly time: VirtualTimeScheduler;
  readonly invoker: ScriptedProviderInvoker;
  readonly caller: ProbeCaller;
}

const validator = createRecordValidator();

function probeHarness(): ProbeHarness {
  const time = new VirtualTimeScheduler({ wallEpochMs: Date.UTC(2026, 9, 5, 12), monotonicOriginNs: 1_000_000_000n });
  const store = new InMemoryItemStore({ clock: time });
  const invoker = new ScriptedProviderInvoker(time);
  const caller = composeProbeCaller({
    deployment: PROBE,
    provider_qualifier: PROVIDER_QUALIFIER,
    store,
    invoker,
    ids: new SequentialUuidSource('dddddddd'),
    wall: time,
    monotonic: time,
    scheduler: time,
  });
  return { store, time, invoker, caller };
}

async function run(harness: ProbeHarness, payload: JsonValue = workloadRequest()): Promise<ProbeWorkloadReport> {
  // A holder, not a local: the flag is set in a callback control-flow analysis cannot see.
  const progress = { done: false };
  const pending = harness.caller.run({ payload, lambda_request_id: 'req-0001' }).finally(() => {
    progress.done = true;
  });
  pending.catch(() => undefined);
  for (let turn = 0; turn < 100 && !progress.done; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await harness.time.advanceUntilIdle();
  }
  return pending;
}

function callerEvents(harness: ProbeHarness): readonly JournalEvent[] {
  return harness.store
    .itemsIn('caller_journal')
    .filter((item) => item.pk === PROBE_PK && !item.sk.startsWith('state#'))
    .map(({ pk: _pk, sk: _sk, ...event }) => event as unknown as JournalEvent);
}

describe('ProbeCaller', () => {
  it('records the invocation start, then exactly one attempt caused by it', async () => {
    const harness = probeHarness();
    harness.invoker.resolveAfter(1_000_000n, succeededResponder);
    const report = await run(harness);

    const events = callerEvents(harness);
    const [started, registered] = events;
    assert.deepEqual(
      events.map((event) => event.record_type),
      ['caller_invocation_started', 'attempt_registered', 'dispatch_started', 'attempt_outcome_recorded'],
    );
    assert.equal((started as unknown as Record<string, unknown>)['lambda_request_id'], 'req-0001');
    assert.equal(started?.source, 'probe_caller');
    assert.equal(started.causation_event_ids, undefined);
    assert.deepEqual(registered?.causation_event_ids, [started.event_id]);
    for (const event of events) {
      const checked = validator.validate(event as unknown as JsonValue);
      assert.ok(checked.valid, JSON.stringify(checked));
    }
    assert.equal(harness.invoker.invocations().length, 1);
    const call = harness.invoker.invocations()[0]?.call;
    assert.equal(call?.caller_id, 'probe');
    assert.equal(call.transport_probe_id, PROBE.execution_kind === 'TRANSPORT_PROBE' ? PROBE.transport_probe_id : '');
    assert.equal(call.trial_id, undefined);
    assert.deepEqual(
      { ...report, attempt: { outcome: report.attempt.outcome, dispatch_state: report.attempt.dispatch_state } },
      {
        transport_probe_id: workloadRequest()['transport_probe_id'],
        lambda_request_id: 'req-0001',
        invocation_event_id: started.event_id,
        attempt: { outcome: 'SUCCEEDED', dispatch_state: 'DISPATCHED' },
      },
    );
  });

  it('never retries: a failed attempt is reported once', async () => {
    const harness = probeHarness();
    harness.invoker.resolveAfter(1_000_000n, () => transportError('TooManyRequestsException', 'Rate exceeded', 429));
    const report = await run(harness);
    assert.equal(report.attempt.outcome, 'FAILED');
    assert.equal(harness.invoker.invocations().length, 1);
    assert.equal(harness.invoker.pendingScriptCount(), 0);
  });

  it('refuses an invalid request before writing or invoking anything', async () => {
    const harness = probeHarness();
    await assert.rejects(run(harness, workloadRequest({ currency: 'USD' })), {
      name: 'ProbeCallerFault',
      code: 'REQUEST_INVALID',
      message: 'REQUEST_INVALID: probe workload request invalid: currency string "USD"; expected BRL',
    });
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    assert.equal(harness.invoker.invocations().length, 0);
  });

  it('refuses a payload nested 20,000 levels deep as REQUEST_INVALID, not a RangeError (review r1)', async () => {
    const harness = probeHarness();
    await assert.rejects(run(harness, workloadRequest({ transport_probe_id: nestedArrays(20_000) })), {
      name: 'ProbeCallerFault',
      code: 'REQUEST_INVALID',
      message:
        'REQUEST_INVALID: probe workload request invalid: transport_probe_id array of length 1; expected a lowercase RFC 4122 version-4 UUID',
    });
    assert.deepEqual(harness.store.itemsIn('caller_journal'), []);
    assert.equal(harness.invoker.invocations().length, 0);
  });

  it('refuses a request outside a transport-probe deployment', async () => {
    const harness = probeHarness();
    const runCaller = composeProbeCaller({
      deployment: RUN,
      provider_qualifier: PROVIDER_QUALIFIER,
      store: harness.store,
      invoker: harness.invoker,
      ids: new SequentialUuidSource('dddddddd'),
      wall: harness.time,
      monotonic: harness.time,
      scheduler: harness.time,
    });
    await assert.rejects(runCaller.run({ payload: workloadRequest(), lambda_request_id: 'req-0002' }), {
      code: 'REQUEST_INVALID',
    });
  });

  it('stops before the attempt when the invocation start cannot be recorded', async () => {
    const harness = probeHarness();
    harness.store.scriptWriteFault(
      { kind: 'ambiguous', code: 'TimeoutError', applied: true },
      { table: 'caller_journal' },
    );
    await assert.rejects(run(harness), {
      code: 'JOURNAL_STOPPED',
      message: 'JOURNAL_STOPPED: caller_invocation_started not written: AMBIGUOUS_APPEND',
    });
    assert.equal(harness.invoker.invocations().length, 0);
  });
});
