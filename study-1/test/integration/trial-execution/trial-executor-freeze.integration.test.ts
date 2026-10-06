// A started trial always freezes (design §10.2 T7-T11, D-29; BR-RUA-032, BR-RUA-043, BR-RUA-044):
// settled, past its deadline or interrupted, with every read or write it could not make reported,
// and the oracle result of its own evidence. Only an evidence index that cannot be written fails
// the freeze. Each case runs the real trial executor in the offline cloud.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { trialFilePath } from '../../../src/trial-execution/trial-inputs.ts';
import { trialRegistryItemKey } from '../../../src/trial-message/trial-registry.ts';
import { OfflineCloud } from '../../support/offline-cloud/offline-cloud.ts';
import { queueTarget } from '../../support/offline-cloud/offline-execution.ts';
import {
  gateValue,
  recordTypes,
  ruleResult,
  runnerEvents,
  textField,
  trialFileBytes,
  trialLines,
  trialRecord,
} from './support/frozen-trial-files.ts';
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

  // Design §9.12 "Conventional COMMIT_THEN_TIMEOUT": receive 1 times out after the targeted commit
  // and receive 2 commits again, so the ledger holds two transactions and BR-RUA-001, -002 and -009
  // fail on a valid trial. Owner amendment A-13 asks WP-26 to recheck WP-14's BR-RUA-004 selection
  // once the real caller writes attempt ids: the first ambiguous attempt is the caller's TIMED_OUT
  // one, every later request state stays UNKNOWN (BR-RUA-004 "UNKNOWN is absorbing"), so it passes.
  it('a treatment trial arms its treatment, re-registers the variant and fails as design §9.12 states', async () => {
    const cloud = await startedCloud();
    frozenReport(await cloud.runTrial(1));
    const running = cloud.start(3);
    const report = frozenReport(await cloud.finish(running));
    const trialId = running.plan.trial.trial_id;
    assert.equal(report.settlement.status, 'established');
    assert.ok(recordTypes(runnerEvents(cloud, trialId)).includes('treatment_armed'));
    assert.equal(cloud.store.peek('trial_registry', trialRegistryItemKey('conventional'))?.['registry_version'], 2);
    const caller = trialLines(cloud, trialId, 'callerJournal');
    const timedOut = caller.find(
      (event) => event['record_type'] === 'attempt_outcome_recorded' && event['outcome'] === 'TIMED_OUT',
    );
    assert.ok(timedOut !== undefined, 'the caller records the first attempt as TIMED_OUT');
    assert.deepEqual(
      caller
        .filter((event) => event['record_type'] === 'request_state_recorded')
        .map((event) => event['effect_knowledge']),
      ['UNKNOWN', 'UNKNOWN'],
    );
    const result = trialRecord(cloud, trialId, 'oracleResult');
    const rules = ['BR-RUA-001', 'BR-RUA-002', 'BR-RUA-003', 'BR-RUA-004', 'BR-RUA-009'];
    assert.deepEqual(
      {
        rules: rules.map((rule) => ruleResult(result, rule)),
        treatment_fidelity: gateValue(result, 'treatment_fidelity'),
        validity: result['trial_validity'],
        verdict: result['preservation_verdict'],
        terminal: result['processing_terminal_reason'],
        correct_completion: result['correct_completion'],
      },
      {
        rules: ['fail', 'fail', 'pass', 'pass', 'fail'],
        treatment_fidelity: 'verified',
        validity: 'valid',
        verdict: 'fail',
        terminal: 'SUCCEEDED',
        correct_completion: false,
      },
    );
    const unknownRule = (result['rule_results'] as readonly JsonObject[]).find(
      (rule) => rule['rule_id'] === 'BR-RUA-004',
    );
    assert.deepEqual(unknownRule?.['expected'], {
      effect_knowledge: 'UNKNOWN',
      first_ambiguous_attempt_id: timedOut['attempt_id'],
    });
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

  // Design §10.2: once an interruption source fires, "the active trial records trial_interrupted"
  // and its available evidence is frozen indeterminate. A trial collecting its evidence (T8) is
  // still active, so the pre-freeze recheck is not taken and settlement is not established.
  it('an interruption during collection records trial_interrupted and freezes without the recheck', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    const trialId = running.plan.trial.trial_id;
    cloud.telemetry.onNextCollection(() => {
      cloud.gate.interrupt(ABORT);
    });
    const report = frozenReport(await cloud.finish(running));
    assert.deepEqual(report.interruption, ABORT);
    assert.equal(report.settlement.status, 'not_established');
    assert.equal(cloud.telemetry.collectionCount(), 1);
    const phases = trialLines(cloud, trialId, 'settlementSamples').map((sample) => sample['phase']);
    assert.equal(phases.includes('pre_freeze_recheck'), false);
    assert.equal(
      runnerEvents(cloud, trialId).find((event) => event['record_type'] === 'trial_interrupted')?.['cause'],
      ABORT.cause,
    );
    assert.equal(verdictOf(cloud, trialId), 'indeterminate');
  });

  it('an interruption during publication stops the observation before its first poll', async () => {
    const cloud = await startedCloud();
    const running = cloud.start(1);
    const trialId = running.plan.trial.trial_id;
    cloud.publisher.tamperNextBody((body) => {
      cloud.gate.interrupt(ABORT);
      return body;
    });
    const report = frozenReport(await cloud.finish(running));
    assert.deepEqual(report.interruption, ABORT);
    assert.equal(report.settlement.status, 'not_established');
    assert.deepEqual(trialLines(cloud, trialId, 'settlementSamples'), []);
    assert.equal(cloud.telemetry.collectionCount(), 1);
    assert.equal(verdictOf(cloud, trialId), 'indeterminate');
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
