// The started transport probe always freezes (design §10.2 T6-T11 and P5 for the probe, D-29;
// BR-RUA-027, BR-RUA-032, BR-RUA-044, AC-RUA-002, AC-RUA-021, AC-RUA-053): the single Invoke of
// the probe caller's published version is journaled with its executed version, observation runs
// under the probe settlement policy from that event, and the frozen probe package holds the
// transport probe result the oracle derives from it, the coordination prefix checkpoint and the
// PROBE evidence index. Every read or write it could not make is reported; only an index that
// cannot be written fails the freeze. Each case runs the real executor and the real probe caller.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EXECUTION_PATHS } from '../../../src/evidence-package/package-layout.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, StructuredReason } from '../../../src/record-contract/primitives.ts';
import { OfflineProbeCloud } from '../../support/offline-cloud/offline-probe-cloud.ts';
import type { OfflineProbeStart } from '../../support/offline-cloud/offline-probe-cloud.ts';
import { recordTypes, textField } from './support/frozen-trial-files.ts';
import { frozenProbeReport, probePath, probeRecord, probeRunnerEvents } from './support/frozen-probe-files.ts';
import { codesOf } from './support/trial-reports.ts';

const ABORT = { cause: 'OPERATOR_ABORT', detail: 'SIGINT' } as const;
const decoder = new TextDecoder();

async function startedProbe(options: OfflineProbeStart = {}): Promise<OfflineProbeCloud> {
  const cloud = new OfflineProbeCloud();
  await cloud.startExecution(options);
  return cloud;
}

function invokedEvent(cloud: OfflineProbeCloud): JsonObject | undefined {
  return probeRunnerEvents(cloud).find((event) => event['record_type'] === 'probe_workload_invoked');
}

function callerStartedRequestIds(cloud: OfflineProbeCloud): readonly unknown[] {
  const bytes = cloud.packageFiles().get(probePath('callerJournal')) ?? new Uint8Array();
  return decoder
    .decode(bytes)
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonObject)
    .filter((event) => event['record_type'] === 'caller_invocation_started')
    .map((event) => event['lambda_request_id']);
}

function indexedPaths(cloud: OfflineProbeCloud): readonly unknown[] {
  const entries = probeRecord(cloud, 'evidenceIndex')['entries'];
  assert.ok(Array.isArray(entries), 'the evidence index lists entries');
  return entries.map((entry) => (entry as JsonObject)['artifact_path']);
}

describe('a frozen transport probe', () => {
  it('invokes the published probe caller once, settles and freezes a passing result (AC-RUA-002, AC-RUA-021)', async () => {
    const cloud = await startedProbe();
    const report = frozenProbeReport(await cloud.runProbe());
    assert.equal(report.settlement.status, 'established');
    assert.deepEqual(report.failures, []);
    assert.equal(report.interruption, undefined);
    assert.equal(report.evidence_index_path, probePath('evidenceIndex'));
    assert.equal(
      sha256Hex(cloud.packageFiles().get(probePath('evidenceIndex')) ?? new Uint8Array()),
      report.evidence_index_sha256,
    );
    const result = probeRecord(cloud, 'transportProbeResult');
    assert.equal(result['transport_probe_verdict'], 'pass');
    assert.equal(result['probe_validity'], 'valid');
    assert.equal(result['treatment_fidelity'], 'verified');
    assert.equal(result['evidence_integrity'], 'verified');
    assert.deepEqual(result['probe_cardinality'], {
      accepted_provider_calls: 1,
      caller_invocations: 1,
      committed_transactions: 1,
    });
    assert.equal(result['transport_probe_id'], cloud.identity.transport_probe_id);
    assert.equal(probeRecord(cloud, 'evidenceIndex')['index_scope'], 'PROBE');
    assert.ok(indexedPaths(cloud).includes(EXECUTION_PATHS.coordinationPrefixCheckpoint));
    assert.ok(indexedPaths(cloud).includes(probePath('transportProbeResult')));
    assert.equal(cloud.packageFiles().has(EXECUTION_PATHS.coordinationPrefixCheckpoint), true);
    assert.deepEqual(
      [...cloud.packageFiles().keys()].filter((path) => path.startsWith('probe/queues/')),
      [],
    );
    assert.deepEqual(cloud.logs.at(-1), {
      level: 'info',
      event: 'probe_evidence_frozen',
      transport_probe_id: cloud.identity.transport_probe_id,
      detail: report.evidence_index_path,
    });
  });

  it('journals the single Invoke with its request id and executed version, and no trial (AC-RUA-053)', async () => {
    const cloud = await startedProbe();
    frozenProbeReport(await cloud.runProbe());
    const events = probeRunnerEvents(cloud);
    assert.deepEqual(recordTypes(events), [
      'trial_partitions_verified_absent',
      'treatment_armed',
      'probe_workload_invoked',
      'settlement_assessed',
      'trial_evidence_frozen',
    ]);
    assert.ok(events.every((event) => !Object.hasOwn(event, 'trial_id')));
    const invoked = invokedEvent(cloud);
    assert.ok(invoked !== undefined);
    assert.equal(invoked['executed_version'], '1');
    assert.equal(invoked['status_code'], 200);
    assert.equal(Object.hasOwn(invoked, 'function_error'), false);
    assert.deepEqual(callerStartedRequestIds(cloud), [invoked['lambda_request_id']]);
    assert.deepEqual(cloud.caller.requests(), [cloud.plan().request]);
    assert.equal(cloud.warmup.requests().length, 1);
    const settlement = events.find((event) => event['record_type'] === 'settlement_assessed');
    assert.ok(settlement !== undefined);
    // Observation counts from the Invoke's own event, as the oracle re-derives probe settlement.
    const windowStart = Date.parse(textField(settlement, 'window_start'));
    assert.ok(windowStart >= Date.parse(textField(invoked, 'occurred_at')));
  });
});

describe('a probe whose Invoke is not cleanly recorded', () => {
  it('freezes unsettled after an Invoke that settled without a response, recording no invocation', async () => {
    const cloud = await startedProbe();
    cloud.caller.scriptNext({ kind: 'ambiguous', code: 'TimeoutError', detail: 'socket hang up' });
    const report = frozenProbeReport(await cloud.runProbe());
    assert.equal(report.settlement.status, 'not_established');
    assert.deepEqual(codesOf(report.failures), ['PROBE_WORKLOAD_INVOKE_AMBIGUOUS']);
    assert.equal(invokedEvent(cloud), undefined);
    assert.equal(cloud.caller.requests().length, 1);
    assert.notEqual(probeRecord(cloud, 'transportProbeResult')['transport_probe_verdict'], 'pass');
  });

  it('records a function error and reports the failed workload', async () => {
    const cloud = await startedProbe();
    cloud.caller.scriptNext({
      kind: 'response',
      status_code: 200,
      executed_version: '1',
      function_error: 'Unhandled',
      payload: new TextEncoder().encode('{"errorType":"Error","errorMessage":"boom"}'),
      request_id: 'scripted-request',
    });
    const report = frozenProbeReport(await cloud.runProbe());
    assert.deepEqual(codesOf(report.failures), ['PROBE_WORKLOAD_FAILED']);
    assert.equal(invokedEvent(cloud)?.['function_error'], 'Unhandled');
    assert.equal(invokedEvent(cloud)?.['lambda_request_id'], 'scripted-request');
    assert.notEqual(probeRecord(cloud, 'transportProbeResult')['transport_probe_verdict'], 'pass');
  });

  it('still freezes when the runner journal refuses the invocation and every later event', async () => {
    const cloud = await startedProbe();
    cloud.store.subscribe('caller_journal', () => {
      void cloud.storage.finalize(cloud.runnerJournalPath());
    });
    const report = frozenProbeReport(await cloud.runProbe());
    assert.deepEqual(codesOf(report.failures), [
      'RUNNER_EVENT_NOT_WRITTEN',
      'RUNNER_EVENT_NOT_WRITTEN',
      'RUNNER_EVENT_NOT_WRITTEN',
    ]);
    assert.equal(invokedEvent(cloud), undefined);
    assert.equal(cloud.packageFiles().has(probePath('transportProbeResult')), true);
  });
});

describe('an interrupted probe', () => {
  async function interruptedAfterInvoke(cloud: OfflineProbeCloud, before: () => Promise<void>): Promise<void> {
    const running = cloud.start();
    await cloud.advanceUntil(() => invokedEvent(cloud) !== undefined);
    await before();
    cloud.gate.interrupt(ABORT);
    const report = frozenProbeReport(await cloud.finish(running));
    assert.deepEqual(report.interruption, ABORT);
    assert.equal(report.settlement.status, 'not_established');
    assert.deepEqual(
      cloud.logs.map((line) => line.event),
      ['probe_interrupted', 'probe_evidence_frozen'],
    );
  }

  it('journals the interruption and freezes', async () => {
    const cloud = await startedProbe();
    await interruptedAfterInvoke(cloud, () => Promise.resolve());
    assert.deepEqual(
      probeRunnerEvents(cloud).find((event) => event['record_type'] === 'trial_interrupted')?.['cause'],
      ABORT.cause,
    );
    assert.equal(cloud.logs[0]?.detail, 'OPERATOR_ABORT: SIGINT');
  });

  it('reports an interruption the runner journal cannot hold', async () => {
    const cloud = await startedProbe();
    await interruptedAfterInvoke(cloud, async () => {
      await cloud.storage.finalize(cloud.runnerJournalPath());
    });
    assert.equal(recordTypes(probeRunnerEvents(cloud)).includes('trial_interrupted'), false);
  });
});

describe('the probe result, the checkpoint and the index at freeze', () => {
  function expectFreezeFailed(
    cloud: OfflineProbeCloud,
    report: Awaited<ReturnType<OfflineProbeCloud['runProbe']>>,
  ): readonly StructuredReason[] {
    assert.equal(report.kind, 'freeze_failed', JSON.stringify(report));
    assert.equal(cloud.logs.at(-1)?.event, 'probe_freeze_failed');
    assert.equal(cloud.packageFiles().has(probePath('evidenceIndex')), false);
    return report.reasons;
  }

  it('fails the freeze when the coordination checkpoint is not written, since the index must hash it', async () => {
    const cloud = await startedProbe();
    const refusal = { code: 'COORDINATION_CHECKPOINT_NOT_WRITTEN', subject: 'BR-RUA-044', detail: 'scripted' };
    cloud.checkpoint.refuseNext(refusal);
    const reasons = expectFreezeFailed(cloud, await cloud.runProbe());
    assert.deepEqual(codesOf(reasons), ['COORDINATION_CHECKPOINT_NOT_WRITTEN', 'CORE_FILE_MISSING']);
    assert.equal(
      cloud.logs.at(-1)?.detail.startsWith('COORDINATION_CHECKPOINT_NOT_WRITTEN: scripted; CORE_FILE_MISSING: '),
      true,
    );
    assert.equal(probeRecord(cloud, 'transportProbeResult')['transport_probe_verdict'], 'pass');
  });

  it('fails the freeze of a package without its execution manifest, with the oracle reason', async () => {
    const cloud = await startedProbe({ omitCoreFiles: ['admission/execution-manifest.json'] });
    const reasons = expectFreezeFailed(cloud, await cloud.runProbe());
    assert.deepEqual(codesOf(reasons), ['PROBE_EXECUTION_UNKNOWN', 'CORE_FILE_MISSING']);
    assert.equal(cloud.packageFiles().has(probePath('transportProbeResult')), false);
  });

  it('freezes without a result when the package cannot be read back', async () => {
    const cloud = await startedProbe();
    cloud.storage.failNextLists(1);
    const report = frozenProbeReport(await cloud.runProbe());
    assert.deepEqual(codesOf(report.failures), ['PACKAGE_UNREADABLE']);
    assert.equal(cloud.packageFiles().has(probePath('transportProbeResult')), false);
    assert.equal(cloud.packageFiles().has(EXECUTION_PATHS.coordinationPrefixCheckpoint), true);
  });

  it('reports a probe result that cannot be written once', async () => {
    const cloud = await startedProbe();
    const path = `${cloud.package_directory}/${probePath('transportProbeResult')}`;
    assert.equal((await cloud.storage.writeOnce(path, Uint8Array.of(1))).ok, true);
    const report = frozenProbeReport(await cloud.runProbe());
    assert.deepEqual(codesOf(report.failures), ['PROBE_FILE_NOT_WRITTEN']);
    assert.equal(report.failures[0]?.artifact_path, path);
  });
});
