// Late-record capture over the offline store, DLQ and Durable fakes (BR-RUA-043, AC-RUA-030,
// AC-RUA-020; design §8.13, §10.4 step 1). Each case freezes a unit with the production collector,
// then writes late records to the same surfaces and re-reads them with `captureLateRecords`: only
// what the frozen artifacts lack is captured, as dense `late_evidence_record` lines, and a read
// that fails is reported instead of being turned into an empty stream.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureLateRecords } from '../../../src/evidence-collection/late-record-capture.ts';
import type { LateCapturePlan, LateRecordStream } from '../../../src/evidence-collection/late-record-capture.ts';
import { recordOfItem } from '../../../src/evidence-collection/collected-records.ts';
import type { JsonObject, Result, StructuredReason, Uuid4 } from '../../../src/record-contract/primitives.ts';
import {
  controllerCanaryAcknowledged,
  timeoutSignalDuplicateObserved,
  timeoutSignalRecorded,
} from '../../contract/record-contract/group-b/examples/controller-examples.ts';
import { conventionalInvocationStarted } from '../../contract/record-contract/group-b/examples/caller-examples.ts';
import {
  providerCallAccepted,
  providerCallRejected,
  providerWarmupCompleted,
} from '../../contract/record-contract/group-b/examples/provider-examples.ts';
import {
  assertValidRecord,
  ledgerItem,
  linesOfBytes,
  sdkEvent,
  sdkExecution,
  sqsMessage,
} from '../../support/evidence-collection/collection-fixtures.ts';
import {
  eventItem,
  executionLevel,
  freezePlan,
  LATE_DLQ,
  LATE_DURABLE,
  LATE_TRIAL_PK,
  LATE_TRIAL_UNIT,
  lateCaptureSurfaces,
  lateExecutionPk,
} from '../../support/evidence-collection/late-record-fixtures.ts';
import type { LateCaptureSurfaces } from '../../support/evidence-collection/late-record-fixtures.ts';
import {
  EXECUTION_MANIFEST_SHA256,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
  toJson,
} from '../../support/record-contract/record-builders.ts';

const CAPTURED_AT = '2026-10-05T12:22:30.000Z';
const TRIAL_CORRELATION = {
  run_id: RUN_ID,
  execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
  trial_id: TRIAL_ID,
  trial_manifest_sha256: TRIAL_MANIFEST_SHA256,
};
const OTHER_TRIAL = '00000000-0000-4000-8000-000000000999' as Uuid4;

// The frozen trial: one event per journal and one ledger transaction.
function seedFrozenTrial(surfaces: LateCaptureSurfaces): void {
  surfaces.store.seed('caller_journal', eventItem(LATE_TRIAL_PK, conventionalInvocationStarted()));
  surfaces.store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, providerCallAccepted()));
  surfaces.store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, timeoutSignalRecorded()));
  surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 1));
}

async function frozenTrialPlan(surfaces: LateCaptureSurfaces): Promise<LateCapturePlan> {
  seedFrozenTrial(surfaces);
  const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT }]);
  surfaces.clock.skewWall(150_000);
  return plan;
}

function captured(result: Result<LateRecordStream, readonly StructuredReason[]>): LateRecordStream {
  assert.ok(result.ok, `expected a captured stream, got ${JSON.stringify(result.ok ? [] : result.error)}`);
  for (const record of result.value.records) {
    assertValidRecord(record, 'late_evidence_record');
  }
  assert.deepEqual(linesOfBytes(result.value.bytes), result.value.records);
  return result.value;
}

function failureCodes(result: Result<LateRecordStream, readonly StructuredReason[]>): readonly string[] {
  assert.ok(!result.ok, 'expected the capture to fail');
  return result.error.map((reason) => reason.code);
}

describe('captureLateRecords over the offline surfaces', () => {
  it('turns a late ledger transaction into one correlated LEDGER record carrying only it (AC-RUA-030)', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 2));
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    assert.equal(stream.records.length, 1);
    const [record] = stream.records;
    assert.ok(record !== undefined);
    const { late_record: carried, ...line } = record;
    assert.deepEqual(line, {
      schema_version: 1,
      record_type: 'late_evidence_record',
      ...TRIAL_CORRELATION,
      sequence: 1,
      captured_at: CAPTURED_AT,
      late_source: 'LEDGER',
      correlated: true,
      late_record_type: 'ledger_snapshot',
    });
    assertValidRecord(carried as JsonObject, 'carried ledger_snapshot');
    assert.deepEqual((carried as JsonObject)['transactions'], [recordOfItem(ledgerItem(LATE_TRIAL_PK, 2))]);
    assert.equal((carried as JsonObject)['complete'], true);
    assert.equal((carried as JsonObject)['partition_key'], LATE_TRIAL_PK);
  });

  it('turns a late timeout_signal_duplicate_observed into one CONTROLLER_JOURNAL record', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    surfaces.store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, timeoutSignalDuplicateObserved()));
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    assert.deepEqual(stream.records, [
      {
        schema_version: 1,
        record_type: 'late_evidence_record',
        ...TRIAL_CORRELATION,
        sequence: 1,
        captured_at: CAPTURED_AT,
        late_source: 'CONTROLLER_JOURNAL',
        correlated: true,
        late_record_type: 'timeout_signal_duplicate_observed',
        late_record: toJson(timeoutSignalDuplicateObserved()),
      },
    ]);
  });

  it('captures an empty stream when nothing new was written after freeze', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    assert.deepEqual(stream.records, []);
    assert.equal(stream.bytes.length, 0);
  });

  it('reports a failed ledger read instead of an empty stream', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    surfaces.store.scriptReadFault('ProvisionedThroughputExceededException', { table: 'ledger' });
    const result = await captureLateRecords(surfaces.ports, plan);
    assert.deepEqual(failureCodes(result), ['LEDGER_READ_FAILED']);
  });

  it('reports a failed journal read, and every other failure of the same capture', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    surfaces.store.scriptReadFault('InternalServerError', { table: 'caller_journal' });
    surfaces.store.scriptReadFault('InternalServerError', { table: 'ledger' });
    const result = await captureLateRecords(surfaces.ports, plan);
    assert.deepEqual(failureCodes(result), ['PARTITION_READ_FAILED', 'LEDGER_READ_FAILED']);
  });

  it('keeps a new event that reuses a frozen event id, so the conflict stays visible', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    const frozen = toJson(timeoutSignalRecorded());
    const moved = { ...frozen, source_sequence: 9 };
    surfaces.store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, moved));
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    assert.deepEqual(
      stream.records.map((record) => record['late_record']),
      [moved],
    );
  });
});

describe('captureLateRecords: DLQ and Durable evidence of a trial', () => {
  it('reuses the freeze correlation: only a new message of the trial group is late (AC-RUA-020)', async () => {
    const surfaces = lateCaptureSurfaces();
    seedFrozenTrial(surfaces);
    surfaces.dlq.enqueue(sqsMessage({ id: 'm1', group: TRIAL_ID }));
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT, dlq: LATE_DLQ }]);
    surfaces.dlq.enqueue(sqsMessage({ id: 'm2', group: TRIAL_ID }));
    surfaces.dlq.enqueue(sqsMessage({ id: 'm3', group: OTHER_TRIAL }));
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    assert.deepEqual(
      stream.records.map((record) => [record['late_source'], record['late_record_type']]),
      [['DLQ', 'dlq_snapshot']],
    );
    const carried = stream.records[0]?.['late_record'] as JsonObject;
    const messages = carried['messages'] as readonly JsonObject[];
    assert.deepEqual(
      messages.map((message) => message['message_id']),
      ['m2'],
    );
    assert.equal(carried['receive_complete'], true);
  });

  it('treats a DLQ with no frozen snapshot as holding nothing (the snapshot is conditional)', async () => {
    const surfaces = lateCaptureSurfaces();
    seedFrozenTrial(surfaces);
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT, dlq: LATE_DLQ }]);
    assert.equal(plan.units[0]?.frozen.dlqSnapshot, undefined);
    surfaces.dlq.enqueue(sqsMessage({ id: 'm1', group: TRIAL_ID }));
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    const carried = stream.records[0]?.['late_record'] as JsonObject;
    assert.deepEqual(
      (carried['messages'] as readonly JsonObject[]).map((message) => message['message_id']),
      ['m1'],
    );
  });

  it('reports a failed DLQ receive', async () => {
    const surfaces = lateCaptureSurfaces();
    seedFrozenTrial(surfaces);
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT, dlq: LATE_DLQ }]);
    surfaces.dlq.scriptFailure('KmsThrottled');
    assert.deepEqual(failureCodes(await captureLateRecords(surfaces.ports, plan)), ['DLQ_RECEIVE_FAILED']);
  });

  it('captures only a Durable execution the frozen listing lacks, not a frozen one that changed status', async () => {
    const surfaces = lateCaptureSurfaces();
    seedFrozenTrial(surfaces);
    surfaces.durable.addExecution(sdkExecution(1, 'RUNNING'), [sdkEvent('ExecutionStarted', 1)]);
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT, durable: LATE_DURABLE }]);
    // The same surfaces after freeze: execution 1 ended and execution 2 started.
    const later = lateCaptureSurfaces();
    seedFrozenTrial(later);
    later.durable.addExecution(sdkExecution(1, 'SUCCEEDED'), [sdkEvent('ExecutionStarted', 1)]);
    later.durable.addExecution(sdkExecution(2, 'FAILED'), [sdkEvent('ExecutionStarted', 1)]);
    const stream = captured(await captureLateRecords(later.ports, plan));
    assert.deepEqual(
      stream.records.map((record) => record['late_source']),
      ['DURABLE_EXECUTION_METADATA'],
    );
    const executions = (stream.records[0]?.['late_record'] as JsonObject)['executions'] as readonly JsonObject[];
    assert.deepEqual(
      executions.map((execution) => execution['durable_execution_arn']),
      [sdkExecution(2, 'FAILED').DurableExecutionArn],
    );
  });

  it('reports a failed Durable listing', async () => {
    const surfaces = lateCaptureSurfaces();
    seedFrozenTrial(surfaces);
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT, durable: LATE_DURABLE }]);
    surfaces.durable.scriptFailure('listPage', 'TooManyRequestsException');
    assert.deepEqual(failureCodes(await captureLateRecords(surfaces.ports, plan)), ['DURABLE_PAGE_READ_FAILED']);
  });
});

describe('captureLateRecords: the probe and the execution-level partitions', () => {
  it('correlates a probe record with the probe, without a trial pair', async () => {
    const surfaces = lateCaptureSurfaces();
    const probeExecution = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: RUN_ID } as const;
    const probePk = `${RUN_ID}#probe`;
    const plan = await freezePlan(surfaces, [{ unit: { kind: 'probe' } }], probeExecution);
    surfaces.store.seed('ledger', ledgerItem(probePk, 1));
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    const [record] = stream.records;
    assert.ok(record !== undefined);
    const { late_record: _carried, ...line } = record;
    assert.deepEqual(line, {
      schema_version: 1,
      record_type: 'late_evidence_record',
      transport_probe_id: RUN_ID,
      execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
      sequence: 1,
      captured_at: '2026-10-05T12:20:00.000Z',
      late_source: 'LEDGER',
      correlated: true,
      late_record_type: 'ledger_snapshot',
    });
  });

  it('correlates the A-09 provider partition and keeps readiness records uncorrelated, in partition order', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    const rejected = executionLevel(providerCallRejected());
    surfaces.store.seed('experiment_journal', eventItem(lateExecutionPk('provider'), rejected));
    surfaces.store.seed('experiment_journal', eventItem(lateExecutionPk('warmup'), providerWarmupCompleted()));
    surfaces.store.seed('experiment_journal', eventItem(lateExecutionPk('canary'), controllerCanaryAcknowledged()));
    surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 2));
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    assert.deepEqual(
      stream.records.map((record) => [
        record['sequence'],
        record['late_source'],
        record['correlated'],
        'trial_id' in record,
      ]),
      [
        [1, 'LEDGER', true, true],
        [2, 'CONTROLLER_JOURNAL', false, false],
        [3, 'PROVIDER_JOURNAL', false, false],
        [4, 'PROVIDER_JOURNAL', true, false],
      ],
    );
    assert.deepEqual(stream.records[3]?.['late_record'], rejected);
    assert.equal(stream.records[3]['run_id'], RUN_ID);
  });

  it('refuses to compare with an execution-level journal that was never frozen', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    const { executionProviderJournal: _dropped, ...frozen } = plan.execution_frozen;
    const result = await captureLateRecords(surfaces.ports, { ...plan, execution_frozen: frozen });
    assert.ok(!result.ok);
    assert.deepEqual(result.error, [
      {
        code: 'LATE_BASELINE_MISSING',
        subject: 'BR-RUA-043',
        detail: `executionProviderJournal of ${RUN_ID}#provider has no frozen copy; expected the frozen artifact the re-read is compared with`,
      },
    ]);
  });
});

describe('captureLateRecords: frozen copies it cannot compare with and records it cannot carry', () => {
  it('reports a missing frozen journal of a unit', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    const [unit] = plan.units;
    assert.ok(unit !== undefined);
    const { callerJournal: _dropped, ...frozen } = unit.frozen;
    const result = await captureLateRecords(surfaces.ports, { ...plan, units: [{ ...unit, frozen }] });
    assert.deepEqual(failureCodes(result), ['LATE_BASELINE_MISSING']);
  });

  it('reports an unreadable frozen ledger and an unreadable frozen journal line', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    const [unit] = plan.units;
    assert.ok(unit !== undefined);
    const broken = {
      ...unit.frozen,
      ledgerSnapshot: new TextEncoder().encode('{"transactions":'),
      controllerJournal: new TextEncoder().encode('{"event_id":1}\nnot json\n'),
    };
    const result = await captureLateRecords(surfaces.ports, { ...plan, units: [{ ...unit, frozen: broken }] });
    assert.ok(!result.ok);
    assert.deepEqual(
      result.error.map((reason) => reason.detail),
      [
        `the frozen controllerJournal of ${LATE_TRIAL_PK} line 2 is not one JSON value (invalid_json); expected the frozen artifact as the collector wrote it`,
        `the frozen ledgerSnapshot of ${LATE_TRIAL_PK} is not one JSON document (invalid_json); expected the frozen artifact as the collector wrote it`,
      ],
    );
    assert.deepEqual(
      result.error.map((reason) => reason.code),
      ['LATE_BASELINE_UNREADABLE', 'LATE_BASELINE_UNREADABLE'],
    );
  });

  it('refuses a new journal item it cannot carry as a record', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    const event = toJson(conventionalInvocationStarted());
    const unversioned = Object.fromEntries(
      Object.entries({ ...event, source_sequence: 7 }).filter(([name]) => name !== 'schema_version'),
    );
    surfaces.store.seed(
      'caller_journal',
      eventItem(LATE_TRIAL_PK, { ...event, source_sequence: 5, record_type: 'Caller' }),
    );
    surfaces.store.seed('caller_journal', eventItem(LATE_TRIAL_PK, { ...event, source_sequence: 6, record_type: 7 }));
    surfaces.store.seed('caller_journal', eventItem(LATE_TRIAL_PK, unversioned));
    const result = await captureLateRecords(surfaces.ports, plan);
    assert.ok(!result.ok);
    assert.deepEqual(
      result.error.map((reason) => reason.detail),
      [
        `a new CALLER_JOURNAL record of ${LATE_TRIAL_PK} has record_type "Caller"; expected a record with schema_version and a lowercase snake record_type`,
        `a new CALLER_JOURNAL record of ${LATE_TRIAL_PK} has no string record_type; expected a record with schema_version and a lowercase snake record_type`,
        `a new CALLER_JOURNAL record of ${LATE_TRIAL_PK} has record_type "caller_invocation_started" but no schema_version; expected a record with schema_version and a lowercase snake record_type`,
      ],
    );
    assert.ok(result.error.every((reason) => reason.code === 'LATE_RECORD_MALFORMED'));
  });

  it('refuses a new record JSON cannot represent instead of writing a broken stream', async () => {
    const surfaces = lateCaptureSurfaces();
    const plan = await frozenTrialPlan(surfaces);
    surfaces.store.seed('ledger', { ...ledgerItem(LATE_TRIAL_PK, 2), amount_minor: Number.POSITIVE_INFINITY });
    assert.deepEqual(failureCodes(await captureLateRecords(surfaces.ports, plan)), ['RECORD_NOT_REPRESENTABLE']);
  });

  it('numbers the lines of several units densely in plan order', async () => {
    const surfaces = lateCaptureSurfaces();
    seedFrozenTrial(surfaces);
    const otherUnit = { kind: 'trial', trial_id: OTHER_TRIAL, trial_manifest_sha256: TRIAL_MANIFEST_SHA256 } as const;
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT }, { unit: otherUnit }]);
    surfaces.store.seed('ledger', ledgerItem(`${RUN_ID}#${OTHER_TRIAL}`, 3));
    surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 2));
    surfaces.store.seed(
      'caller_journal',
      eventItem(LATE_TRIAL_PK, {
        ...toJson(conventionalInvocationStarted()),
        source_sequence: 2,
        event_id: OTHER_TRIAL,
      }),
    );
    const stream = captured(await captureLateRecords(surfaces.ports, plan));
    assert.deepEqual(
      stream.records.map((record) => [record['sequence'], record['trial_id'], record['late_source']]),
      [
        [1, TRIAL_ID, 'CALLER_JOURNAL'],
        [2, TRIAL_ID, 'LEDGER'],
        [3, OTHER_TRIAL, 'LEDGER'],
      ],
    );
  });
});
