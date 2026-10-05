// The composed treatment controller over the InMemoryItemStore emulator (design §5.3, §9.11,
// BR-RUA-025): the signal transaction, one journal record per decision, records it cannot
// attribute, and the faults that make the stream mapping retry within its bound.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  CALLER_EVENT_ID,
  CANARY_PK,
  COMMIT_EVENT_ID,
  OTHER_ATTEMPT_ID,
  OTHER_CALLER_EVENT_ID,
  OTHER_RUN_ID,
  PROBE,
  PROBE_PK,
  PROVIDER_COMMIT_ID,
  RUN,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  armedTreatmentItem,
  assertSchemaValid,
  callerTimeoutImage,
  committedTreatmentItem,
  controllerEvents,
  controllerHarness,
  onlyControllerEvent,
  probeConfigItem,
  signalledTreatmentItem,
  streamInsert,
  trialConfigItem,
} from '../../unit/treatment-controller/support/controller-fixtures.ts';
import type { ControllerHarness } from '../../unit/treatment-controller/support/controller-fixtures.ts';
import { scriptedControllerHarness } from './support/controller-integration-fixtures.ts';

function field(value: unknown, name: string): unknown {
  return (value as JsonObject)[name];
}

function seededProbe(treatment: JsonObject | undefined): ControllerHarness {
  const harness = controllerHarness(PROBE);
  harness.store.seed('control', probeConfigItem());
  if (treatment !== undefined) {
    harness.store.seed('control', { ...treatment, pk: PROBE_PK, sk: 'treatment' });
  }
  return harness;
}

describe('TreatmentController signal', () => {
  it('moves COMMITTED_WAITING to TIMEOUT_SIGNALLED with timeout_signal_recorded in one transaction', async () => {
    const harness = seededProbe(committedTreatmentItem(PROBE_PK));
    const result = await harness.controller.handle(streamInsert(callerTimeoutImage('probe')));

    const signal = onlyControllerEvent(harness, PROBE_PK);
    assert.deepEqual(result, { outcome: 'signal', partition_key: PROBE_PK, detail: `signalled by ${CALLER_EVENT_ID}` });
    assert.equal(signal.record_type, 'timeout_signal_recorded');
    assert.deepEqual(field(signal, 'causation_event_ids'), [CALLER_EVENT_ID, COMMIT_EVENT_ID]);
    assert.equal(field(signal, 'provider_commit_event_id'), COMMIT_EVENT_ID);
    assert.equal(field(signal, 'provider_commit_id'), PROVIDER_COMMIT_ID);
    assert.equal(field(signal, 'source_sequence'), 1);
    assertSchemaValid([signal as unknown as JsonObject]);
    assert.deepEqual(harness.store.peek('control', { pk: PROBE_PK, sk: 'treatment' }), {
      ...committedTreatmentItem(PROBE_PK),
      state: 'TIMEOUT_SIGNALLED',
      version: 3,
      signal_event_id: signal.event_id,
      signal_caller_event_id: CALLER_EVENT_ID,
    });
    const operations = harness.log.entries().map((entry) => entry.operation);
    assert.deepEqual(
      operations.filter((operation) => operation !== 'GetItem'),
      ['TransactWriteItems'],
    );
  });

  it('signals in a run trial partition with the trial identity of the configuration', async () => {
    const harness = controllerHarness(RUN);
    harness.store.seed('control', trialConfigItem('COMMIT_THEN_TIMEOUT'));
    harness.store.seed('control', committedTreatmentItem(TRIAL_PK));
    const result = await harness.controller.handle(streamInsert(callerTimeoutImage('trial')));
    const signal = onlyControllerEvent(harness, TRIAL_PK);
    assert.equal(result.outcome, 'signal');
    assert.equal(field(signal, 'trial_id'), TRIAL_ID);
    assert.equal(field(signal, 'trial_manifest_sha256'), TRIAL_MANIFEST_SHA);
    assertSchemaValid([signal as unknown as JsonObject]);
  });
});

describe('TreatmentController answers without a state change', () => {
  const rows: readonly [string, JsonObject | undefined, JsonObject, string, string][] = [
    ['ARMED', armedTreatmentItem(PROBE_PK), {}, 'before_commit_rejected', 'caller_timeout_rejected'],
    [
      'COMMITTED_WAITING, no match',
      committedTreatmentItem(PROBE_PK),
      { attempt_id: OTHER_ATTEMPT_ID },
      'not_targeted_rejected',
      'caller_timeout_rejected',
    ],
    [
      'TIMEOUT_OBSERVED, this event',
      signalledTreatmentItem(PROBE_PK, 'TIMEOUT_OBSERVED'),
      {},
      'duplicate_ignored',
      'timeout_signal_duplicate_observed',
    ],
    [
      'RESPONSE_RELEASED, another event',
      signalledTreatmentItem(PROBE_PK, 'RESPONSE_RELEASED', OTHER_CALLER_EVENT_ID),
      {},
      'conflict',
      'timeout_signal_conflict_recorded',
    ],
    ['SAFETY_RELEASED', { state: 'SAFETY_RELEASED', version: 3 }, {}, 'late_rejected', 'late_timeout_signal_rejected'],
    ['no treatment item', undefined, {}, 'invalid_event_rejected', 'caller_timeout_rejected'],
    [
      'invalid event',
      committedTreatmentItem(PROBE_PK),
      { source: 'durable_caller' },
      'invalid_event_rejected',
      'caller_timeout_rejected',
    ],
  ];
  for (const [row, treatment, overrides, outcome, recordType] of rows) {
    it(`${row}: ${outcome}, one ${recordType}, treatment unchanged`, async () => {
      const harness = seededProbe(treatment);
      const before = harness.store.peek('control', { pk: PROBE_PK, sk: 'treatment' });
      const result = await harness.controller.handle(streamInsert(callerTimeoutImage('probe', overrides)));
      const record = onlyControllerEvent(harness, PROBE_PK);
      assert.equal(result.outcome, outcome);
      assert.equal(result.detail, `recorded ${recordType}`);
      assert.equal(record.record_type, recordType);
      assertSchemaValid([record as unknown as JsonObject]);
      assert.deepEqual(harness.store.peek('control', { pk: PROBE_PK, sk: 'treatment' }), before);
    });
  }

  it('CONTROL configuration: control_trial_rejected in the trial partition', async () => {
    const harness = controllerHarness(RUN);
    harness.store.seed('control', trialConfigItem('CONTROL'));
    const result = await harness.controller.handle(streamInsert(callerTimeoutImage('trial')));
    const record = onlyControllerEvent(harness, TRIAL_PK);
    assert.equal(result.outcome, 'control_trial_rejected');
    assert.equal(field(record, 'reason'), 'CONTROL_TRIAL');
    assertSchemaValid([record as unknown as JsonObject]);
  });

  it('canary partition: controller_canary_acknowledged under the canary digest, no control read', async () => {
    const harness = controllerHarness(PROBE);
    const result = await harness.controller.handle(streamInsert(callerTimeoutImage('canary')));
    const ack = onlyControllerEvent(harness, CANARY_PK);
    assert.equal(result.outcome, 'canary_acknowledged');
    assert.equal(field(ack, 'canary_event_id'), CALLER_EVENT_ID);
    assertSchemaValid([ack as unknown as JsonObject]);
    assert.deepEqual(
      harness.log.entries().filter((entry) => entry.operation === 'GetItem'),
      [],
    );
  });
});

describe('TreatmentController ignores records it cannot attribute', () => {
  type Insert = ReturnType<typeof streamInsert>;
  const cases: readonly [string, () => Insert, string | null, string][] = [
    [
      'a MODIFY',
      (): Insert => streamInsert(callerTimeoutImage('probe'), 'MODIFY'),
      null,
      'MODIFY of string "caller_timeout_recorded"; expected an INSERT of caller_timeout_recorded',
    ],
    [
      'another record type',
      (): Insert => streamInsert(callerTimeoutImage('probe', { record_type: 'dispatch_started' })),
      null,
      'INSERT of string "dispatch_started"; expected an INSERT of caller_timeout_recorded',
    ],
    [
      'another execution',
      (): Insert => streamInsert(callerTimeoutImage('probe', { pk: `${OTHER_RUN_ID}#probe` })),
      `${OTHER_RUN_ID}#probe`,
      'partition not served by this deployment',
    ],
    [
      'an unconfigured partition',
      (): Insert => streamInsert(callerTimeoutImage('probe')),
      PROBE_PK,
      'no journal scope: canary digest unusable or configuration absent',
    ],
    [
      'a canary without a usable digest',
      (): Insert => streamInsert(callerTimeoutImage('canary', { execution_manifest_sha256: 'x' })),
      CANARY_PK,
      'no journal scope: canary digest unusable or configuration absent',
    ],
  ];
  for (const [name, record, partitionKey, detail] of cases) {
    it(`writes nothing for ${name}`, async () => {
      const harness = controllerHarness(PROBE);
      assert.deepEqual(await harness.controller.handle(record()), {
        outcome: 'record_ignored',
        partition_key: partitionKey,
        detail,
      });
      assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
    });
  }
});

describe('TreatmentController faults', () => {
  it('fails with STATE_UNREADABLE on a failed configuration read', async () => {
    const harness = seededProbe(committedTreatmentItem(PROBE_PK));
    harness.store.scriptReadFault('ProvisionedThroughputExceededException', { table: 'control' });
    await assert.rejects(harness.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      name: 'ControllerFault',
      code: 'STATE_UNREADABLE',
      message: `STATE_UNREADABLE: ProvisionedThroughputExceededException: control read ${PROBE_PK}/config failed: ProvisionedThroughputExceededException`,
    });
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('fails with STATE_UNREADABLE on a failed treatment read', async () => {
    const harness = scriptedControllerHarness(PROBE);
    harness.store.seed('control', probeConfigItem());
    harness.store.seed('control', committedTreatmentItem(PROBE_PK));
    harness.state.failNextTreatmentRead({ code: 'InternalServerError', detail: 'treatment read failed' });
    await assert.rejects(harness.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'STATE_UNREADABLE',
      message: 'STATE_UNREADABLE: InternalServerError: treatment read failed',
    });
    assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
  });

  it('fails with STATE_UNREADABLE on an undecodable configuration or treatment item', async () => {
    const badConfig = controllerHarness(PROBE);
    badConfig.store.seed('control', probeConfigItem({ scenario: 'CHAOS' }));
    await assert.rejects(badConfig.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'STATE_UNREADABLE',
      message: `STATE_UNREADABLE: UndecodableItem: control item ${PROBE_PK}/config: scenario string "CHAOS"; expected one of CONTROL, COMMIT_THEN_TIMEOUT`,
    });
    const badTreatment = seededProbe({ state: 'TIMEOUT_SIGNALLED', version: 3 });
    await assert.rejects(badTreatment.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'STATE_UNREADABLE',
    });
  });

  it('fails with JOURNAL_STOPPED when its record cannot be written', async () => {
    const ambiguous = seededProbe(armedTreatmentItem(PROBE_PK));
    ambiguous.store.scriptWriteFault(
      { kind: 'ambiguous', code: 'TimeoutError', applied: false },
      { table: 'experiment_journal' },
    );
    await assert.rejects(ambiguous.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'JOURNAL_STOPPED',
      message: 'JOURNAL_STOPPED: before_commit_rejected record not written: AMBIGUOUS_APPEND',
    });
    const exhausted = seededProbe(armedTreatmentItem(PROBE_PK));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      exhausted.store.scriptWriteFault(
        { kind: 'definitive_failure', code: 'ValidationException' },
        { table: 'experiment_journal' },
      );
    }
    await assert.rejects(exhausted.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      message: 'JOURNAL_STOPPED: before_commit_rejected record not written: DEFINITIVE_RETRIES_EXHAUSTED',
    });
    assert.deepEqual(exhausted.store.itemsIn('experiment_journal'), []);
  });

  it('fails with SIGNAL_AMBIGUOUS on an ambiguous signal transaction; the bounded retry sees the duplicate', async () => {
    const harness = seededProbe(committedTreatmentItem(PROBE_PK));
    harness.store.scriptWriteFault(
      { kind: 'ambiguous', code: 'TimeoutError', applied: true },
      { operation: 'transact' },
    );
    const record = streamInsert(callerTimeoutImage('probe'));
    await assert.rejects(harness.controller.handle(record), {
      code: 'SIGNAL_AMBIGUOUS',
      message: 'SIGNAL_AMBIGUOUS: signal transaction AMBIGUOUS_APPEND; expected applied',
    });
    const retried = await harness.controller.handle(record);
    assert.equal(retried.outcome, 'duplicate_ignored');
    assert.deepEqual(
      controllerEvents(harness, PROBE_PK).map((event) => event.record_type),
      ['timeout_signal_recorded', 'timeout_signal_duplicate_observed'],
    );
  });

  it('fails with SIGNAL_FAILED on a definitive signal failure and leaves treatment unchanged', async () => {
    const harness = seededProbe(committedTreatmentItem(PROBE_PK));
    harness.store.scriptWriteFault(
      { kind: 'definitive_failure', code: 'ValidationException' },
      { operation: 'transact' },
    );
    await assert.rejects(harness.controller.handle(streamInsert(callerTimeoutImage('probe'))), {
      code: 'SIGNAL_FAILED',
      message:
        'SIGNAL_FAILED: signal transaction {"kind":"definitive_failure","code":"ValidationException"}; expected applied or a failed treatment condition',
    });
    assert.deepEqual(
      harness.store.peek('control', { pk: PROBE_PK, sk: 'treatment' }),
      committedTreatmentItem(PROBE_PK),
    );
    assert.deepEqual(controllerEvents(harness, PROBE_PK), []);
  });
});
