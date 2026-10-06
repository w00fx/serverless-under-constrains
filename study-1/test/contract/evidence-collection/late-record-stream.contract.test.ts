// The late stream contract between the collector and the late-evidence assessment (BR-RUA-043,
// BR-RUA-033, catalogue group C row 77; AC-RUA-030). What `captureLateRecords` writes is what
// WP-15's `readLateStream` reads: every line of a trial execution is accepted with the route the
// frozen evidence gives it (`routeLateRecord`), readiness records are kept uncorrelated, and a
// probe's lines correlate with the probe without a trial pair.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureLateRecords } from '../../../src/evidence-collection/late-record-capture.ts';
import type { LateRecordStream } from '../../../src/evidence-collection/late-record-capture.ts';
import { EXECUTION_PATHS, PACKAGE_LAYOUT } from '../../../src/evidence-package/package-layout.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { readLateStream } from '../../../src/trial-oracle/late-evidence/late-stream-reading.ts';
import { conventionalInvocationStarted } from '../record-contract/group-b/examples/caller-examples.ts';
import {
  controllerCanaryAcknowledged,
  timeoutSignalDuplicateObserved,
  timeoutSignalRecorded,
} from '../record-contract/group-b/examples/controller-examples.ts';
import { providerCallAccepted, providerCallRejected } from '../record-contract/group-b/examples/provider-examples.ts';
import {
  ledgerItem,
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
import {
  EXECUTION_MANIFEST_SHA256,
  PROBE_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA256,
} from '../../support/record-contract/record-builders.ts';

const validator = createRecordValidator();
const TRIAL_UNIT = { kind: 'trial', trial_id: TRIAL_ID } as const;

function capturedStream(result: Awaited<ReturnType<typeof captureLateRecords>>): LateRecordStream {
  assert.ok(result.ok, `expected a captured stream, got ${JSON.stringify(result.ok ? [] : result.error)}`);
  return result.value;
}

describe('late stream contract: trial executions', () => {
  it('every captured line is accepted by readLateStream with the route of its frozen artifact', async () => {
    const surfaces = lateCaptureSurfaces();
    surfaces.store.seed('caller_journal', eventItem(LATE_TRIAL_PK, conventionalInvocationStarted()));
    surfaces.store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, providerCallAccepted()));
    surfaces.store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, timeoutSignalRecorded()));
    surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 1));
    surfaces.durable.addExecution(sdkExecution(1, 'SUCCEEDED'), [sdkEvent('ExecutionStarted', 1)]);
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT, dlq: LATE_DLQ, durable: LATE_DURABLE }]);
    surfaces.store.seed('experiment_journal', eventItem(LATE_TRIAL_PK, timeoutSignalDuplicateObserved()));
    surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 2));
    surfaces.dlq.enqueue(sqsMessage({ id: 'late-message', group: TRIAL_ID }));
    surfaces.durable.addExecution(sdkExecution(2, 'FAILED'), [sdkEvent('ExecutionStarted', 1)]);
    surfaces.store.seed(
      'experiment_journal',
      eventItem(lateExecutionPk('provider'), executionLevel(providerCallRejected())),
    );
    surfaces.store.seed('experiment_journal', eventItem(lateExecutionPk('canary'), controllerCanaryAcknowledged()));
    const stream = capturedStream(await captureLateRecords(surfaces.ports, plan));

    const reading = readLateStream(
      { path: EXECUTION_PATHS.lateEvidenceStream, bytes: stream.bytes },
      {
        execution: { run_id: RUN_ID },
        execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
        trial_manifests: new Map([[TRIAL_ID, TRIAL_MANIFEST_SHA256]]),
      },
      validator,
    );

    assert.deepEqual(reading.problems, []);
    assert.deepEqual(
      reading.accepted.map((accepted) => [accepted.line_number, accepted.record.late_source, accepted.route]),
      [
        [
          1,
          'CONTROLLER_JOURNAL',
          { path: PACKAGE_LAYOUT.unitFile(TRIAL_UNIT, 'controllerJournal'), fold: 'append_line', shared: false },
        ],
        [
          2,
          'LEDGER',
          { path: PACKAGE_LAYOUT.unitFile(TRIAL_UNIT, 'ledgerSnapshot'), fold: 'ledger_transactions', shared: false },
        ],
        [3, 'DLQ', { path: PACKAGE_LAYOUT.unitFile(TRIAL_UNIT, 'dlqSnapshot'), fold: 'dlq_messages', shared: false }],
        [
          4,
          'DURABLE_EXECUTION_METADATA',
          {
            path: PACKAGE_LAYOUT.unitFile(TRIAL_UNIT, 'durableExecutions'),
            fold: 'durable_executions',
            shared: false,
          },
        ],
        [6, 'PROVIDER_JOURNAL', { path: EXECUTION_PATHS.executionProviderJournal, fold: 'append_line', shared: true }],
      ],
    );
    assert.equal(stream.records.length, 6);
    assert.deepEqual(
      [stream.records[4]?.['late_source'], stream.records[4]?.['correlated']],
      ['CONTROLLER_JOURNAL', false],
    );
  });

  it('an empty capture reads as no late record and no problem', async () => {
    const surfaces = lateCaptureSurfaces();
    surfaces.store.seed('ledger', ledgerItem(LATE_TRIAL_PK, 1));
    const plan = await freezePlan(surfaces, [{ unit: LATE_TRIAL_UNIT }]);
    const stream = capturedStream(await captureLateRecords(surfaces.ports, plan));
    const reading = readLateStream(
      { path: EXECUTION_PATHS.lateEvidenceStream, bytes: stream.bytes },
      {
        execution: { run_id: RUN_ID },
        execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
        trial_manifests: new Map([[TRIAL_ID, TRIAL_MANIFEST_SHA256]]),
      },
      validator,
    );
    assert.deepEqual(reading, { accepted: [], problems: [] });
  });
});

describe('late stream contract: the transport probe', () => {
  it('correlates every probe line with the probe, with no trial pair, and carries valid records', async () => {
    const surfaces = lateCaptureSurfaces();
    const execution = { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: PROBE_ID } as const;
    const probePk = `${PROBE_ID}#probe`;
    const plan = await freezePlan(surfaces, [{ unit: { kind: 'probe' } }], execution);
    surfaces.store.seed('ledger', ledgerItem(probePk, 1));
    const stream = capturedStream(await captureLateRecords(surfaces.ports, plan));
    assert.equal(stream.records.length, 1);
    for (const record of stream.records) {
      const validation = validator.validateAs('late_evidence_record', record);
      assert.deepEqual(validation.valid ? [] : validation.violations, []);
      assert.equal(record['transport_probe_id'], PROBE_ID);
      assert.equal(record['correlated'], true);
      assert.equal('trial_id' in record || 'trial_manifest_sha256' in record || 'run_id' in record, false);
      const carried = validator.validate(record['late_record'] as JsonObject);
      assert.deepEqual(carried.valid ? [] : carried.violations, []);
      assert.equal((record['late_record'] as JsonObject)['partition_key'], probePk);
    }
  });
});
