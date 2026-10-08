// Treatment and configuration snapshots (design §5.3, §9.3; A-09): strongly consistent point reads
// of the `treatment`, `config`, registry and execution configuration items.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  captureExecutionConfiguration,
  captureProviderTrialConfiguration,
  captureTreatmentSnapshot,
  captureTrialRegistration,
} from '../../../src/evidence-collection/state-capture.ts';
import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import {
  runProviderExecutionConfiguration,
  trialProviderConfiguration,
  trialRegistration,
} from '../../contract/record-contract/group-a/support/manifest-examples.ts';
import {
  assertValidRecord,
  collectionClock,
  EXECUTION,
  PROBE_PK,
  PROBE_SCOPE,
  RUN_ID,
  TRIAL_PK,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';

const asJson = (record: object): JsonObject => JSON.parse(JSON.stringify(record)) as JsonObject;

describe('captureTreatmentSnapshot', () => {
  it('records an absent treatment item as item_present false (CONTROL, G4a)', async () => {
    const { store } = storeHarness();
    const snapshot = await captureTreatmentSnapshot(store, TRIAL_SCOPE, collectionClock());
    assert.ok(snapshot.ok);
    assertValidRecord(snapshot.value.record, 'absent treatment');
    assert.equal(snapshot.value.record['item_present'], false);
    assert.equal(snapshot.value.treatment, undefined);
    assert.equal(snapshot.value.record['consistent_read'], true);
    assert.equal(snapshot.value.record['partition_key'], TRIAL_PK);
  });

  it('records the treatment item without its key', async () => {
    const { store } = storeHarness();
    store.seed('control', { pk: PROBE_PK, sk: 'treatment', state: 'ARMED', version: 1 });
    const snapshot = await captureTreatmentSnapshot(store, PROBE_SCOPE, collectionClock());
    assert.ok(snapshot.ok);
    assertValidRecord(snapshot.value.record, 'probe treatment');
    assert.deepEqual(snapshot.value.record['treatment'], { state: 'ARMED', version: 1 });
    assert.deepEqual(snapshot.value.treatment, { state: 'ARMED', version: 1 });
    assert.equal('trial_id' in snapshot.value.record, false);
  });

  it('fails when the item cannot be read', async () => {
    const { store } = storeHarness();
    store.scriptReadFault('InternalServerError', { operation: 'getConsistent', table: 'control' });
    const snapshot = await captureTreatmentSnapshot(store, TRIAL_SCOPE, collectionClock());
    assert.equal(snapshot.ok ? '' : snapshot.error.code, 'STATE_READ_FAILED');
    assert.match(snapshot.ok ? '' : snapshot.error.detail, /treatment failed with InternalServerError/);
  });
});

describe('configuration and registration records', () => {
  it('copies the trial `config` item as the provider_trial_configuration record', async () => {
    const { store } = storeHarness();
    const configuration = asJson(trialProviderConfiguration());
    store.seed('control', { ...configuration, pk: TRIAL_PK, sk: 'config' });
    const read = await captureProviderTrialConfiguration(store, TRIAL_SCOPE);
    assert.deepEqual(read, { ok: true, value: configuration });
    assertValidRecord(read.value);
  });

  it('copies the variant registry item as the trial_registration record (D-21)', async () => {
    const { store } = storeHarness();
    const registration = asJson(trialRegistration());
    store.seed('trial_registry', { ...registration, pk: 'registry#conventional', sk: 'active' });
    assert.deepEqual(await captureTrialRegistration(store, 'conventional'), { ok: true, value: registration });
  });

  it('copies the execution configuration item `<execution_id>#execution`/`config` (A-09)', async () => {
    const { store } = storeHarness();
    const configuration = asJson(runProviderExecutionConfiguration());
    store.seed('control', { ...configuration, pk: `${RUN_ID}#execution`, sk: 'config' });
    assert.deepEqual(await captureExecutionConfiguration(store, EXECUTION), { ok: true, value: configuration });
  });

  it('reports an absent item, naming it', async () => {
    const { store } = storeHarness();
    const read = await captureTrialRegistration(store, 'durable');
    assert.equal(read.ok ? '' : read.error.code, 'STATE_ITEM_ABSENT');
    assert.match(read.ok ? '' : read.error.detail, /^trial_registry item registry#durable\/active is absent/);
  });

  it('reports a failed read', async () => {
    const { store } = storeHarness();
    store.scriptReadFault('AccessDeniedException');
    const read = await captureExecutionConfiguration(store, EXECUTION);
    assert.equal(read.ok ? '' : read.error.code, 'STATE_READ_FAILED');
  });
});
