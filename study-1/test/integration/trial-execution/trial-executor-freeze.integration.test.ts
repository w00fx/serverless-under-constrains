// A started trial always freezes (design §10.2 T7-T11, D-29; BR-RUA-032, BR-RUA-043, BR-RUA-044):
// settled, past its deadline or interrupted, with every read or write it could not make reported,
// and the oracle result of its own evidence. Only an evidence index that cannot be written fails
// the freeze. Each case runs the real trial executor in the offline cloud.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { Uuid4 } from '../../../src/record-contract/primitives.ts';
import { trialFilePath } from '../../../src/trial-execution/trial-inputs.ts';
import { trialRegistryItemKey } from '../../../src/trial-message/trial-registry.ts';
import { OfflineCloud } from '../../support/offline-cloud/offline-cloud.ts';
import { queueTarget } from '../../support/offline-cloud/offline-execution.ts';
import { recordTypes, runnerEvents, textField, trialFileBytes, trialRecord } from './support/frozen-trial-files.ts';
import { codesOf, frozenReport } from './support/trial-reports.ts';

const SERVICE_FAULT = 'InternalServerError';
const ABORT = { cause: 'OPERATOR_ABORT', detail: 'SIGINT' } as const;

async function startedCloud(): Promise<OfflineCloud> {
  const cloud = new OfflineCloud('run');
  await cloud.startExecution();
  return cloud;
}

function publishedMs(cloud: OfflineCloud, trialId: Uuid4): number {
  const published = runnerEvents(cloud, trialId).find((event) => event['record_type'] === 'trial_message_published');
  assert.ok(published !== undefined, 'trial_message_published is journaled');
  return Date.parse(textField(published, 'occurred_at'));
}

async function advanceToOffset(cloud: OfflineCloud, trialId: Uuid4, offsetMs: number): Promise<void> {
  await cloud.advanceUntil(() => recordTypes(runnerEvents(cloud, trialId)).includes('trial_message_published'));
  await cloud.advanceUntil(() => cloud.time.now().getTime() >= publishedMs(cloud, trialId) + offsetMs);
}

function verdictOf(cloud: OfflineCloud, trialId: Uuid4): unknown {
  return trialRecord(cloud, trialId, 'oracleResult')['preservation_verdict'];
}

describe('frozen trials', () => {
  it('a CONTROL trial settles, freezes with an index over its exact bytes and passes', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    const report = frozenReport(await cloud.finish(running));
    const trialId = running.plan.trial.trial_id;
    assert.equal(report.settlement.status, 'established');
    assert.deepEqual(report.failures, []);
    assert.equal(report.interruption, undefined);
    assert.equal(sha256Hex(trialFileBytes(cloud, trialId, 'evidenceIndex')), report.evidence_index_sha256);
    assert.deepEqual(recordTypes(runnerEvents(cloud, trialId)), [
      'trial_partitions_verified_absent',
      'trial_message_published',
      'settlement_assessed',
      'trial_evidence_frozen',
    ]);
    assert.equal(verdictOf(cloud, trialId), 'pass');
    assert.equal(cloud.warmup.requests().length, 1);
    assert.deepEqual(cloud.logs.at(-1), {
      level: 'info',
      event: 'trial_evidence_frozen',
      trial_id: trialId,
      detail: report.evidence_index_path,
    });
  });

  it('a treatment trial after it arms its treatment, re-registers the variant and fails', async () => {
    const cloud = await startedCloud();
    frozenReport(await cloud.runTrial(1));
    const running = cloud.start(3);
    const report = frozenReport(await cloud.finish(running));
    const trialId = running.plan.trial.trial_id;
    assert.equal(report.settlement.status, 'established');
    assert.ok(recordTypes(runnerEvents(cloud, trialId)).includes('treatment_armed'));
    assert.equal(cloud.store.peek('trial_registry', trialRegistryItemKey('conventional'))?.['registry_version'], 2);
    assert.equal(verdictOf(cloud, trialId), 'fail');
  });

  it('a Durable trial that never settles freezes at its deadline, indeterminate', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(2);
    const report = frozenReport(await cloud.finish(running));
    const trialId = running.plan.trial.trial_id;
    assert.equal(report.settlement.status, 'not_established');
    const published = new Date(publishedMs(cloud, trialId)).toISOString();
    assert.ok(cloud.durable.listingRequests().length > 0);
    assert.ok(cloud.durable.listingRequests().every((request) => request.started_after === published));
    assert.equal(verdictOf(cloud, trialId), 'indeterminate');
  });
});

describe('interrupted trials', () => {
  it('an interruption while observing records trial_interrupted and freezes what was collected', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    const trialId = running.plan.trial.trial_id;
    await advanceToOffset(cloud, trialId, 45_000);
    cloud.gate.interrupt(ABORT);
    const report = frozenReport(await cloud.finish(running));
    assert.deepEqual(report.interruption, ABORT);
    assert.equal(report.settlement.status, 'not_established');
    assert.deepEqual(report.failures, []);
    assert.deepEqual(
      runnerEvents(cloud, trialId).find((event) => event['record_type'] === 'trial_interrupted')?.['cause'],
      ABORT.cause,
    );
    assert.ok(
      cloud.logs.some((line) => line.event === 'trial_interrupted' && line.detail === 'OPERATOR_ABORT: SIGINT'),
    );
    assert.equal(verdictOf(cloud, trialId), 'indeterminate');
  });

  it('an interruption during collection stops the next observation before its first poll', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    cloud.telemetry.onNextCollection(() => {
      cloud.pump.pause();
      cloud.injectSourceMessage();
      cloud.gate.interrupt(ABORT);
    });
    const report = frozenReport(await cloud.finish(running));
    assert.deepEqual(report.interruption, ABORT);
    assert.equal(cloud.telemetry.collectionCount(), 2);
    assert.ok(report.settlement.restarts.some((restart) => restart.cause === 'PRE_FREEZE_ACTIVITY'));
  });

  it('an interruption the runner journal cannot record is reported', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    await advanceToOffset(cloud, running.plan.trial.trial_id, 45_000);
    await cloud.storage.finalize(cloud.runnerJournalPath());
    cloud.gate.interrupt(ABORT);
    const report = frozenReport(await cloud.finish(running));
    assert.deepEqual(codesOf(report.failures), [
      'RUNNER_EVENT_NOT_WRITTEN',
      'RUNNER_EVENT_NOT_WRITTEN',
      'RUNNER_EVENT_NOT_WRITTEN',
    ]);
  });
});

describe('freeze failures', () => {
  it('fails the freeze when the evidence index cannot be written', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    const index = trialFilePath(cloud.execution.package_directory, running.plan.trial.trial_id, 'evidenceIndex');
    cloud.telemetry.onNextCollection(() => {
      void cloud.storage.writeOnce(index, Uint8Array.of(1));
    });
    const report = await cloud.finish(running);
    assert.equal(report.kind, 'freeze_failed');
    assert.deepEqual(codesOf(report.reasons), ['TRIAL_FILE_NOT_WRITTEN']);
    assert.equal(cloud.logs.at(-1)?.event, 'trial_freeze_failed');
    assert.equal(cloud.logs.at(-1)?.level, 'error');
  });

  it('reports an unreadable package at evaluation and fails the freeze when the index cannot list it', async () => {
    const evaluation = await startedCloud();
    evaluation.telemetry.onNextCollection(() => {
      evaluation.storage.failNextLists(1);
    });
    const evaluated = frozenReport(await evaluation.finish(evaluation.start(1)));
    assert.deepEqual(codesOf(evaluated.failures), ['PACKAGE_UNREADABLE']);
    const indexing = await startedCloud();
    indexing.telemetry.onNextCollection(() => {
      indexing.storage.failNextLists(2);
    });
    const indexed = await indexing.finish(indexing.start(1));
    assert.deepEqual(indexed.kind === 'freeze_failed' ? codesOf(indexed.reasons) : indexed.kind, [
      'PACKAGE_UNREADABLE',
      'PACKAGE_UNREADABLE',
    ]);
  });
});

describe('fail-closed settlement reads', () => {
  it('a journal or treatment read that fails counts as correlated activity and is reported', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    await advanceToOffset(cloud, running.plan.trial.trial_id, 45_000);
    cloud.store.scriptReadFault(SERVICE_FAULT, { operation: 'queryPartitionPage', table: 'caller_journal' });
    await cloud.advanceBy(30_000);
    cloud.store.scriptReadFault(SERVICE_FAULT, { operation: 'getConsistent', table: 'control' });
    const report = frozenReport(await cloud.finish(running));
    assert.equal(report.settlement.status, 'established');
    assert.ok(codesOf(report.failures).includes('TREATMENT_READ_FAILED'));
    assert.equal(report.failures.length, 2);
    assert.deepEqual(
      report.settlement.restarts.map((restart) => restart.cause),
      ['CORRELATED_JOURNAL_ACTIVITY', 'CORRELATED_JOURNAL_ACTIVITY'],
    );
  });

  it('a DLQ whose counters cannot be read is not quiet', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    await advanceToOffset(cloud, running.plan.trial.trial_id, 45_000);
    cloud.counters.failNext(queueTarget(cloud.execution.context, 'conventional', 'dlq').queue_url, SERVICE_FAULT);
    const report = frozenReport(await cloud.finish(running));
    assert.equal(report.settlement.status, 'established');
    assert.equal(report.settlement.restarts.length, 1);
  });
});
