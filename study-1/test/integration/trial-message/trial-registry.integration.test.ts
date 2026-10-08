// The registry read port over the durable store (design D-21; BR-RUA-036): a strongly
// consistent read of the variant's item, checked before use, on the InMemoryItemStore emulator
// of DynamoDB item semantics.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STORE_CODES } from '../../../src/durable-store/item-store-port.ts';
import {
  createStoreTrialRegistry,
  toTrialRegistryItem,
  trialRegistryItemKey,
} from '../../../src/trial-message/trial-registry.ts';
import { InMemoryItemStore } from '../../support/durable-store/in-memory-item-store.ts';
import { VirtualTimeScheduler } from '../../support/kernel/virtual-time-scheduler.ts';
import { EPOCH_MS, runRegistration } from '../../unit/trial-message/support/trial-message-fixtures.ts';

function emptyStore(): InMemoryItemStore {
  return new InMemoryItemStore({ clock: new VirtualTimeScheduler({ wallEpochMs: EPOCH_MS }) });
}

describe('createStoreTrialRegistry', () => {
  it('reports no active trial when the variant has no item', async () => {
    assert.deepEqual(await createStoreTrialRegistry(emptyStore()).activeTrial('conventional'), {
      ok: true,
      value: undefined,
    });
  });

  it('returns the stored registration of the asked variant only', async () => {
    const store = emptyStore();
    store.seed('trial_registry', toTrialRegistryItem(runRegistration()));
    const registry = createStoreTrialRegistry(store);
    assert.deepEqual(await registry.activeTrial('conventional'), { ok: true, value: runRegistration() });
    assert.deepEqual(await registry.activeTrial('durable'), { ok: true, value: undefined });
  });

  it('reports a failed read as REGISTRY_UNREADABLE with the store code', async () => {
    const store = emptyStore();
    store.scriptReadFault('ProvisionedThroughputExceededException', { table: 'trial_registry' });
    assert.deepEqual(await createStoreTrialRegistry(store).activeTrial('conventional'), {
      ok: false,
      error: {
        code: 'REGISTRY_UNREADABLE',
        detail: 'trial registry read for conventional failed: "ProvisionedThroughputExceededException"',
      },
    });
  });

  it('reports a damaged item as REGISTRATION_INVALID', async () => {
    const store = emptyStore();
    store.seed('trial_registry', { ...toTrialRegistryItem(runRegistration()), registry_version: 0 });
    const read = await createStoreTrialRegistry(store).activeTrial('conventional');
    assert.equal(read.ok, false);
    assert.equal(read.error.code, 'REGISTRATION_INVALID');
    assert.match(read.error.detail, /registry_version number 0/);
  });

  it('reports an item that names another variant as REGISTRATION_INVALID', async () => {
    const store = emptyStore();
    store.seed('trial_registry', {
      ...runRegistration(),
      variant_id: 'durable',
      ...trialRegistryItemKey('conventional'),
    });
    assert.deepEqual(await createStoreTrialRegistry(store).activeTrial('conventional'), {
      ok: false,
      error: {
        code: 'REGISTRATION_INVALID',
        detail: 'registry item of conventional names variant_id durable; expected conventional',
      },
    });
  });

  it('reads the trial_registry table only', async () => {
    const store = emptyStore();
    store.seed('caller_journal', toTrialRegistryItem(runRegistration()));
    store.scriptReadFault(STORE_CODES.validation, { table: 'caller_journal' });
    assert.deepEqual(await createStoreTrialRegistry(store).activeTrial('conventional'), { ok: true, value: undefined });
  });
});
