// Trial setup before publication (design §10.2 A-09, T1-T6; BR-RUA-019, BR-RUA-036, BR-RUA-045,
// addendum §2): every refusal before the trial message is on the queue starts no trial, sends no
// message and reports why. Each case runs the real trial executor in the offline cloud with one
// scripted fault at the step under test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Sha256Hex } from '../../../src/record-contract/primitives.ts';
import {
  CONFIG_SORT_KEY,
  TREATMENT_SORT_KEY,
  executionConfigPartition,
} from '../../../src/refund-provider/control-items.ts';
import { writeExecutionConfiguration } from '../../../src/trial-execution/execution-configuration.ts';
import { trialFilePath } from '../../../src/trial-execution/trial-inputs.ts';
import { trialRegistryItemKey } from '../../../src/trial-message/trial-registry.ts';
import { OfflineCloud } from '../../support/offline-cloud/offline-cloud.ts';
import type { RunningTrial } from '../../support/offline-cloud/offline-cloud.ts';
import { recordTypes, runnerEvents } from './support/frozen-trial-files.ts';
import { codesOf, frozenReport, notStartedReasons } from './support/trial-reports.ts';

const SERVICE_FAULT = 'InternalServerError';

async function startedCloud(options: { readonly withExecutionConfiguration?: boolean } = {}): Promise<OfflineCloud> {
  const cloud = new OfflineCloud('run');
  await cloud.startExecution(options);
  return cloud;
}

// A refused trial: no message sent, the refusal logged, nothing past T1 journaled.
async function refusedCodes(cloud: OfflineCloud, running: RunningTrial): Promise<readonly string[]> {
  const reasons = notStartedReasons(await cloud.finish(running));
  assert.deepEqual(cloud.publisher.sends(), [], 'no trial message is sent');
  assert.equal(cloud.logs.at(-1)?.event, 'trial_not_started');
  assert.equal(
    recordTypes(runnerEvents(cloud, running.plan.trial.trial_id)).includes('trial_message_published'),
    false,
  );
  return codesOf(reasons);
}

function trialFilesWritten(cloud: OfflineCloud): readonly string[] {
  return [...cloud.packageFiles().keys()].filter((path) => path.startsWith('trials/'));
}

describe('trial execution preconditions (A-09, T5 gate)', () => {
  it('refuses a trial with no execution configuration and a closed gate, writing nothing', async () => {
    const cloud = await startedCloud({ withExecutionConfiguration: false });
    cloud.gate.withholdPublication();
    const codes = await refusedCodes(cloud, cloud.start(1));
    assert.deepEqual(codes, ['EXECUTION_CONFIGURATION_MISSING', 'PUBLICATION_GATE_CLOSED']);
    assert.deepEqual(trialFilesWritten(cloud), []);
  });

  it('refuses a trial when the configuration read fails, is invalid or names another manifest', async () => {
    const unreadable = await startedCloud();
    unreadable.store.scriptReadFault(SERVICE_FAULT, { operation: 'getConsistent', table: 'control' });
    const invalid = await startedCloud({ withExecutionConfiguration: false });
    const pk = executionConfigPartition(invalid.execution.identity);
    invalid.store.seed('control', { pk, sk: CONFIG_SORT_KEY, record_type: 'not_a_configuration' });
    const other = await startedCloud({ withExecutionConfiguration: false });
    const otherDigest = 'b'.repeat(64) as Sha256Hex;
    const written = await writeExecutionConfiguration(
      other.store,
      { execution: other.execution.identity, execution_manifest_sha256: otherDigest },
      other.time,
    );
    assert.equal(written.ok, true);
    const details: string[] = [];
    for (const cloud of [unreadable, invalid, other]) {
      const reasons = notStartedReasons(await cloud.finish(cloud.start(1)));
      assert.deepEqual(codesOf(reasons), ['EXECUTION_CONFIGURATION_MISSING']);
      details.push(reasons[0]?.detail ?? '');
    }
    assert.match(details[0] ?? '', new RegExp(`failed with ${SERVICE_FAULT}`));
    assert.match(details[2] ?? '', new RegExp(`names manifest ${otherDigest}`));
    assert.match(details[1] ?? '', new RegExp(pk));
    assert.doesNotMatch(details[1] ?? '', /failed with|names manifest/);
  });

  it('refuses a trial when the configuration write is refused at execution start', async () => {
    const cloud = await startedCloud();
    const again = await writeExecutionConfiguration(
      cloud.store,
      { execution: cloud.execution.identity, execution_manifest_sha256: cloud.execution.execution_manifest_sha256 },
      cloud.time,
    );
    assert.equal(again.ok ? 'applied' : again.error.code, 'EXECUTION_CONFIGURATION_NOT_WRITTEN');
  });

  it('refuses a trial when no trial may start or the execution is interrupted, naming the cause', async () => {
    const refused = await startedCloud();
    refused.gate.refuseTrials();
    assert.deepEqual(await refusedCodes(refused, refused.start(1)), ['PUBLICATION_GATE_CLOSED']);
    const interrupted = await startedCloud();
    interrupted.gate.interrupt({ cause: 'OPERATOR_ABORT', detail: 'SIGINT' });
    const reasons = notStartedReasons(await interrupted.finish(interrupted.start(1)));
    assert.match(reasons[0]?.detail ?? '', /OPERATOR_ABORT: SIGINT/);
  });
});

describe('trial setup T1-T4', () => {
  it('T1: refuses a trial whose payment file already exists, writing the other inputs', async () => {
    const cloud = await startedCloud();
    const plan = cloud.plan(1);
    const path = trialFilePath(cloud.execution.package_directory, plan.trial.trial_id, 'payment');
    assert.equal((await cloud.storage.writeOnce(path, Uint8Array.of(1))).ok, true);
    const reasons = notStartedReasons(await cloud.finish(cloud.startPlan(plan)));
    assert.deepEqual(codesOf(reasons), ['TRIAL_FILE_NOT_WRITTEN']);
    assert.equal(reasons[0]?.artifact_path, path);
    assert.equal(trialFilesWritten(cloud).length, 3);
  });

  it('T2: refuses a trial whose partition holds an item or cannot be read', async () => {
    const seeded = await startedCloud();
    const pk = `${seeded.execution.context.execution_id}#${seeded.plan(1).trial.trial_id}`;
    seeded.store.seed('ledger', { pk, sk: 'leftover' });
    assert.deepEqual(await refusedCodes(seeded, seeded.start(1)), ['PARTITION_NOT_EMPTY']);
    const unreadable = await startedCloud();
    unreadable.store.scriptReadFault(SERVICE_FAULT, { operation: 'queryPartitionPage', table: 'experiment_journal' });
    assert.deepEqual(await refusedCodes(unreadable, unreadable.start(1)), ['PARTITION_UNREADABLE']);
  });

  it('T2: refuses a trial whose runner event cannot be journaled', async () => {
    const cloud = await startedCloud();
    await cloud.storage.finalize(cloud.runnerJournalPath());
    assert.deepEqual(await refusedCodes(cloud, cloud.start(1)), ['RUNNER_EVENT_NOT_WRITTEN']);
  });

  it('T3: refuses a trial whose control or registry write is not applied', async () => {
    const control = await startedCloud();
    control.store.scriptWriteFault({ kind: 'definitive_failure', code: SERVICE_FAULT }, { table: 'control' });
    assert.deepEqual(await refusedCodes(control, control.start(1)), ['SETUP_WRITE_NOT_APPLIED']);
    const registry = await startedCloud();
    registry.store.scriptWriteFault(
      { kind: 'ambiguous', code: 'TimeoutError', applied: false },
      { table: 'trial_registry' },
    );
    assert.deepEqual(await refusedCodes(registry, registry.start(1)), ['SETUP_WRITE_NOT_APPLIED']);
  });

  it('T3: refuses a trial whose registry item cannot be read or is invalid', async () => {
    const unreadable = await startedCloud();
    unreadable.store.scriptReadFault(SERVICE_FAULT, { operation: 'getConsistent', table: 'trial_registry' });
    const invalid = await startedCloud();
    invalid.store.seed('trial_registry', { ...trialRegistryItemKey('conventional'), registry_version: 'one' });
    for (const cloud of [unreadable, invalid]) {
      assert.deepEqual(await refusedCodes(cloud, cloud.start(1)), ['REGISTRY_UNREADABLE']);
    }
  });

  it('T4: refuses a treatment trial whose treatment item or treatment_armed is not written', async () => {
    const refused = await startedCloud();
    refused.store.subscribe('trial_registry', () => {
      refused.store.scriptWriteFault({ kind: 'definitive_failure', code: SERVICE_FAULT }, { table: 'control' });
    });
    assert.deepEqual(await refusedCodes(refused, refused.start(3)), ['SETUP_WRITE_NOT_APPLIED']);
    const unjournaled = await startedCloud();
    unjournaled.store.subscribe('control', (change) => {
      if (change.keys.sk === TREATMENT_SORT_KEY) {
        void unjournaled.storage.finalize(unjournaled.runnerJournalPath());
      }
    });
    assert.deepEqual(await refusedCodes(unjournaled, unjournaled.start(3)), ['RUNNER_EVENT_NOT_WRITTEN']);
  });
});

describe('provider warm-up and the T5 gate', () => {
  it('refuses a trial whose provider warm-up fails', async () => {
    const cloud = await startedCloud();
    cloud.warmup.failNext({ kind: 'transport_error', error_name: 'TimeoutError', message: 'socket hang up' });
    assert.deepEqual(await refusedCodes(cloud, cloud.start(1)), ['PROVIDER_WARMUP_FAILED']);
    assert.equal(cloud.warmup.requests().length, 1);
  });

  it('refuses a trial when the gate closes during setup, after the warm-up', async () => {
    const cloud = await startedCloud();
    cloud.store.subscribe('trial_registry', () => {
      cloud.gate.withholdPublication();
    });
    assert.deepEqual(await refusedCodes(cloud, cloud.start(1)), ['PUBLICATION_GATE_CLOSED']);
    assert.equal(cloud.warmup.requests().length, 1);
  });
});

describe('T6 publication', () => {
  it('refuses a trial whose message does not validate, before writing it', async () => {
    const cloud = await startedCloud();
    const plan = cloud.plan(1);
    const bad = { ...plan, approved_decision: { ...plan.approved_decision, refund_request_id: ' bad' } } as typeof plan;
    assert.deepEqual(await refusedCodes(cloud, cloud.startPlan(bad)), ['SCHEMA_INVALID']);
    assert.deepEqual(
      trialFilesWritten(cloud).map((path) => path.split('/').slice(2).join('/')),
      ['inputs/approved-decision.json', 'inputs/payment.json', 'trial-manifest.json'],
    );
  });

  it('refuses a trial whose published-message file already exists', async () => {
    const cloud = await startedCloud();
    const plan = cloud.plan(1);
    const path = trialFilePath(cloud.execution.package_directory, plan.trial.trial_id, 'publishedMessage');
    assert.equal((await cloud.storage.writeOnce(path, Uint8Array.of(1))).ok, true);
    assert.deepEqual(await refusedCodes(cloud, cloud.startPlan(plan)), ['TRIAL_FILE_NOT_WRITTEN']);
  });

  it('refuses a trial whose send is rejected', async () => {
    const cloud = await startedCloud();
    cloud.publisher.failNext({ kind: 'rejected', code: 'AccessDenied' });
    const running = cloud.start(1);
    const reasons = notStartedReasons(await cloud.finish(running));
    assert.deepEqual(codesOf(reasons), ['TRIAL_MESSAGE_NOT_SENT']);
    assert.equal(cloud.publisher.sends().length, 1);
  });

  it('starts and freezes a trial whose send is ambiguous, reporting it', async () => {
    const cloud = await startedCloud();
    cloud.publisher.failNext({ kind: 'ambiguous', code: 'RequestTimeout' });
    const running = cloud.start(1);
    const report = frozenReport(await cloud.finish(running));
    assert.ok(codesOf(report.failures).includes('TRIAL_MESSAGE_SEND_AMBIGUOUS'));
    assert.equal(
      recordTypes(runnerEvents(cloud, running.plan.trial.trial_id)).includes('trial_message_published'),
      false,
    );
  });

  it('starts and freezes a sent trial whose trial_message_published cannot be journaled', async () => {
    const cloud = await startedCloud();
    cloud.publisher.tamperNextBody((body) => {
      void cloud.storage.finalize(cloud.runnerJournalPath());
      return body;
    });
    const report = frozenReport(await cloud.finish(cloud.start(1)));
    assert.deepEqual(codesOf(report.failures).slice(0, 1), ['RUNNER_EVENT_NOT_WRITTEN']);
    assert.match(report.failures.map((failure) => failure.detail).join('; '), /trial_message_published/);
  });
});
