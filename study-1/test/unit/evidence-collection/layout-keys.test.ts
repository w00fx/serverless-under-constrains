// The collector names its files by the evidence-package layout keys and its control items by the
// spellings the provider writes; it cannot import either feature (same layer, design §5.4), so
// this test is the one place that ties them together.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONTROL_ITEM_KEYS } from '../../../src/evidence-collection/state-capture.ts';
import { EXECUTION_JOURNAL_PARTITIONS } from '../../../src/evidence-collection/readiness-collection.ts';
import { unitJournalPlans } from '../../../src/evidence-collection/journal-export.ts';
import { EXECUTION_PATHS, UNIT_PATHS } from '../../../src/evidence-package/package-layout.ts';
import {
  CONFIG_SORT_KEY,
  EXECUTION_PARTITION_SUFFIX,
  TREATMENT_SORT_KEY,
} from '../../../src/refund-provider/control-items.ts';
import type { CollectedFileKey } from '../../../src/evidence-collection/collection-buffer.ts';

/** Every unit file key a trial collection produces. */
const UNIT_KEYS: readonly CollectedFileKey[] = [
  'ledgerSnapshot',
  'dlqSnapshot',
  'callerJournal',
  'providerJournal',
  'controllerJournal',
  'treatmentStateSnapshot',
  'providerTrialConfiguration',
  'trialRegistration',
  'durableExecutions',
  'telemetryAvailability',
];

describe('layout keys and control item spellings', () => {
  it('names every unit file by a UNIT_PATHS key', () => {
    for (const key of [
      ...UNIT_KEYS,
      ...unitJournalPlans('p').flatMap((plan) => plan.routes.map((route) => route.file)),
    ]) {
      assert.ok(Object.hasOwn(UNIT_PATHS, key), key);
    }
  });

  it('names every execution-level journal by an EXECUTION_PATHS key', () => {
    for (const partition of EXECUTION_JOURNAL_PARTITIONS) {
      assert.ok(Object.hasOwn(EXECUTION_PATHS, partition.route.file), partition.route.file);
    }
  });

  it('spells the control items as the provider writes them (design §9.3, A-09)', () => {
    assert.equal(CONTROL_ITEM_KEYS.configuration, CONFIG_SORT_KEY);
    assert.equal(CONTROL_ITEM_KEYS.treatment, TREATMENT_SORT_KEY);
    assert.equal(CONTROL_ITEM_KEYS.executionPartitionSuffix, EXECUTION_PARTITION_SUFFIX);
  });
});
