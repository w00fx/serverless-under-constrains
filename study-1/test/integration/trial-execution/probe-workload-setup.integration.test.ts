// The probe workload before its Invoke (design §10.2 P4 for the probe; BR-RUA-019, BR-RUA-027,
// BR-RUA-045, A-09, addendum §2.1, D-06): the same setup as a trial, in `<execution_id>#probe`,
// with the probe's own configuration (caller `probe`, COMMIT_THEN_TIMEOUT, no registry item), one
// warm-up naming no trial, and the gate. Any refusal, and a definitive Lambda rejection of the
// Invoke, starts no probe: the probe caller is never run, or never runs.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIG_SORT_KEY, TREATMENT_SORT_KEY } from '../../../src/refund-provider/control-items.ts';
import { trialRegistryItemKey } from '../../../src/trial-message/trial-registry.ts';
import { OfflineProbeCloud } from '../../support/offline-cloud/offline-probe-cloud.ts';
import type { OfflineProbeStart } from '../../support/offline-cloud/offline-probe-cloud.ts';
import { recordTypes } from './support/frozen-trial-files.ts';
import { probePath, probeNotStartedReasons, probeRunnerEvents } from './support/frozen-probe-files.ts';
import { codesOf } from './support/trial-reports.ts';

const SERVICE_FAULT = 'InternalServerError';

async function startedProbe(options: OfflineProbeStart = {}): Promise<OfflineProbeCloud> {
  const cloud = new OfflineProbeCloud();
  await cloud.startExecution(options);
  return cloud;
}

// A probe that did not start: its caller never journaled an invocation, nothing was invoked
// unless Lambda rejected the Invoke, and no probe_workload_invoked was recorded.
async function refusedCodes(cloud: OfflineProbeCloud): Promise<readonly string[]> {
  const reasons = probeNotStartedReasons(await cloud.runProbe());
  assert.equal(cloud.logs.at(-1)?.event, 'probe_not_started');
  assert.equal(recordTypes(probeRunnerEvents(cloud)).includes('probe_workload_invoked'), false);
  const callerJournal = await cloud.store.queryPartitionPage(
    'caller_journal',
    `${cloud.identity.transport_probe_id}#probe`,
  );
  assert.deepEqual(callerJournal.ok ? callerJournal.value.items : 'unreadable', [], 'the probe caller never ran');
  return codesOf(reasons);
}

describe('probe workload preconditions', () => {
  it('refuses a probe without the execution configuration or with a closed gate, writing nothing', async () => {
    const cloud = await startedProbe({ withExecutionConfiguration: false });
    cloud.gate.withholdPublication();
    assert.deepEqual(await refusedCodes(cloud), ['EXECUTION_CONFIGURATION_MISSING', 'PUBLICATION_GATE_CLOSED']);
    assert.deepEqual(
      [...cloud.packageFiles().keys()].filter((path) => path.startsWith('probe/')),
      [],
    );
    assert.equal(cloud.warmup.requests().length, 0);
    assert.equal(cloud.caller.requests().length, 0);
  });

  it('refuses a probe whose input file already exists', async () => {
    const cloud = await startedProbe();
    const path = `${cloud.package_directory}/${probePath('payment')}`;
    assert.equal((await cloud.storage.writeOnce(path, Uint8Array.of(1))).ok, true);
    const reasons = probeNotStartedReasons(await cloud.runProbe());
    assert.deepEqual(codesOf(reasons), ['PROBE_FILE_NOT_WRITTEN']);
    assert.equal(reasons[0]?.artifact_path, path);
    assert.equal(cloud.packageFiles().has(probePath('approvedDecision')), true);
  });
});

describe('probe workload setup in the probe partition', () => {
  it('writes the probe inputs, configuration and armed treatment, and registers nothing', async () => {
    const cloud = await startedProbe();
    cloud.caller.scriptNext({ kind: 'rejected', code: 'ResourceNotFoundException', detail: 'scripted' });
    assert.deepEqual(await refusedCodes(cloud), ['PROBE_WORKLOAD_NOT_INVOKED']);
    const pk = `${cloud.identity.transport_probe_id}#probe`;
    const plan = cloud.plan();
    const configuration = await cloud.store.getConsistent('control', { pk, sk: CONFIG_SORT_KEY });
    assert.ok(configuration.ok && configuration.value !== undefined);
    assert.equal(configuration.value['registered_caller_id'], 'probe');
    assert.equal(configuration.value['scenario'], 'COMMIT_THEN_TIMEOUT');
    assert.equal(configuration.value['transport_probe_id'], cloud.identity.transport_probe_id);
    assert.equal(configuration.value['payment_id'], plan.payment.payment_id);
    assert.equal(configuration.value['safety_release_ms'], plan.provider_timing.safety_release_ms);
    assert.equal(Object.hasOwn(configuration.value, 'trial_id'), false);
    const treatment = await cloud.store.getConsistent('control', { pk, sk: TREATMENT_SORT_KEY });
    assert.deepEqual(treatment.ok ? treatment.value : undefined, {
      pk,
      sk: TREATMENT_SORT_KEY,
      state: 'ARMED',
      version: 1,
    });
    for (const variant of ['conventional', 'durable'] as const) {
      const registry = await cloud.store.getConsistent('trial_registry', trialRegistryItemKey(variant));
      assert.equal(registry.ok ? registry.value : 'unreadable', undefined, variant);
    }
    const events = probeRunnerEvents(cloud);
    assert.deepEqual(recordTypes(events), ['trial_partitions_verified_absent', 'treatment_armed']);
    assert.equal(events[0]?.['partition_key'], pk);
    assert.ok(
      events.every(
        (event) =>
          !Object.hasOwn(event, 'trial_id') && event['transport_probe_id'] === cloud.identity.transport_probe_id,
      ),
    );
    assert.equal(cloud.packageFiles().has(probePath('payment')), true);
    assert.equal(cloud.caller.requests().length, 1);
  });

  it('refuses a probe whose partition holds an item', async () => {
    const cloud = await startedProbe();
    cloud.store.seed('ledger', { pk: `${cloud.identity.transport_probe_id}#probe`, sk: 'leftover' });
    assert.deepEqual(await refusedCodes(cloud), ['PARTITION_NOT_EMPTY']);
  });

  it('refuses a probe whose control write is not applied', async () => {
    const cloud = await startedProbe();
    cloud.store.scriptWriteFault({ kind: 'definitive_failure', code: SERVICE_FAULT }, { table: 'control' });
    assert.deepEqual(await refusedCodes(cloud), ['SETUP_WRITE_NOT_APPLIED']);
  });
});

describe('probe warm-up and the T5 gate', () => {
  it('warms the provider once with a request naming the probe and no trial', async () => {
    const cloud = await startedProbe();
    cloud.caller.scriptNext({ kind: 'rejected', code: 'TooManyRequestsException', detail: 'scripted' });
    await cloud.runProbe();
    const [request, ...others] = cloud.warmup.requests();
    assert.deepEqual(others, []);
    assert.ok(request !== undefined);
    assert.equal(
      Object.entries(request).find(([key]) => key === 'transport_probe_id')?.[1],
      cloud.identity.transport_probe_id,
    );
    assert.equal(Object.hasOwn(request, 'trial_id'), false);
  });

  it('refuses a probe whose warm-up fails, before any Invoke', async () => {
    const cloud = await startedProbe();
    cloud.warmup.failNext({ kind: 'transport_error', error_name: 'TimeoutError', message: 'socket hang up' });
    assert.deepEqual(await refusedCodes(cloud), ['PROVIDER_WARMUP_FAILED']);
    assert.equal(cloud.caller.requests().length, 0);
  });

  it('refuses a probe when the gate closes during setup, after the warm-up', async () => {
    const cloud = await startedProbe();
    cloud.store.subscribe('control', (change) => {
      if (change.keys.sk === TREATMENT_SORT_KEY) {
        cloud.gate.refuseTrials();
      }
    });
    assert.deepEqual(await refusedCodes(cloud), ['PUBLICATION_GATE_CLOSED']);
    assert.equal(cloud.warmup.requests().length, 1);
    assert.equal(cloud.caller.requests().length, 0);
  });
});
