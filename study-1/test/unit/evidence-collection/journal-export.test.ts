// Journal exports (design §7 `journals/`, §9.3; BR-RUA-033): each partition read whole, its items
// split by the source their sort key names, caller state left out, and an item no route claims
// failing the export instead of vanishing from it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CALLER_SOURCES,
  exportJournals,
  routeJournalItems,
  unitJournalPlans,
} from '../../../src/evidence-collection/journal-export.ts';
import type { JournalExportPlan } from '../../../src/evidence-collection/journal-export.ts';
import { journalItem, linesOfBytes, TRIAL_PK } from '../../support/evidence-collection/collection-fixtures.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';
import { uuid } from '../../contract/record-contract/group-a/support/sample-values.ts';

const [CALLER_PLAN, EXPERIMENT_PLAN] = unitJournalPlans(TRIAL_PK) as readonly [JournalExportPlan, JournalExportPlan];

describe('unitJournalPlans', () => {
  it('exports the caller journal, then the provider and controller halves of the experiment journal', () => {
    assert.deepEqual(CALLER_PLAN, {
      table: 'caller_journal',
      partition_key: TRIAL_PK,
      routes: [{ file: 'callerJournal', sources: CALLER_SOURCES }],
    });
    assert.deepEqual(
      EXPERIMENT_PLAN.routes.map((route) => [route.file, route.sources]),
      [
        ['providerJournal', ['refund_provider']],
        ['controllerJournal', ['treatment_controller']],
      ],
    );
    assert.deepEqual(CALLER_SOURCES, ['conventional_caller', 'durable_caller', 'probe_caller']);
  });
});

describe('exportJournals', () => {
  it('splits the experiment journal by source, each file in sort-key order, keys dropped', async () => {
    const { store } = storeHarness(2);
    store.seed(
      'experiment_journal',
      journalItem(TRIAL_PK, 'treatment_controller', 1, { record_type: 'timeout_signal_recorded' }),
    );
    store.seed(
      'experiment_journal',
      journalItem(TRIAL_PK, 'refund_provider', 2, { record_type: 'provider_call_accepted' }),
    );
    store.seed(
      'experiment_journal',
      journalItem(TRIAL_PK, 'refund_provider', 1, { record_type: 'provider_call_received' }),
    );
    const exported = await exportJournals(store, EXPERIMENT_PLAN);
    assert.ok(exported.ok);
    const [provider, controller] = exported.value;
    assert.equal(provider?.file, 'providerJournal');
    assert.deepEqual(
      provider.events.map((event) => event['record_type']),
      ['provider_call_received', 'provider_call_accepted'],
    );
    assert.deepEqual(linesOfBytes(provider.bytes), provider.events);
    assert.equal(controller?.file, 'controllerJournal');
    assert.deepEqual(controller.events, [
      { record_type: 'timeout_signal_recorded', source: 'treatment_controller', source_sequence: 1 },
    ]);
  });

  it('keeps instances contiguous and in sequence order (the sort key orders them)', async () => {
    const { store } = storeHarness();
    for (const [instance, sequence] of [
      [2, 1],
      [1, 2],
      [2, 2],
      [1, 1],
    ] as const) {
      store.seed(
        'caller_journal',
        journalItem(
          TRIAL_PK,
          'conventional_caller',
          sequence,
          { n: `${String(instance)}.${String(sequence)}` },
          uuid(instance),
        ),
      );
    }
    const exported = await exportJournals(store, CALLER_PLAN);
    assert.deepEqual(exported.ok ? exported.value[0]?.events.map((event) => event['n']) : [], [
      '1.1',
      '1.2',
      '2.1',
      '2.2',
    ]);
  });

  it('leaves caller state items out of the caller journal', async () => {
    const { store } = storeHarness();
    store.seed('caller_journal', { pk: TRIAL_PK, sk: `state#attempt#${uuid(1)}`, outcome_class: 'AMBIGUOUS' });
    store.seed('caller_journal', { pk: TRIAL_PK, sk: 'state#request#ref-poc-001', attempt_ids: [] });
    store.seed(
      'caller_journal',
      journalItem(TRIAL_PK, 'durable_caller', 1, { record_type: 'caller_invocation_started' }),
    );
    const exported = await exportJournals(store, CALLER_PLAN);
    assert.deepEqual(exported.ok ? exported.value[0]?.events.map((event) => event['record_type']) : [], [
      'caller_invocation_started',
    ]);
  });

  it('writes an empty file for a source with no event (an empty journal is valid evidence)', async () => {
    const { store } = storeHarness();
    const exported = await exportJournals(store, EXPERIMENT_PLAN);
    assert.deepEqual(exported.ok ? exported.value.map((file) => [file.file, file.bytes.length]) : [], [
      ['providerJournal', 0],
      ['controllerJournal', 0],
    ]);
  });

  it('fails the export when the partition cannot be read', async () => {
    const { store } = storeHarness();
    store.scriptReadFault('InternalServerError');
    const exported = await exportJournals(store, CALLER_PLAN);
    assert.equal(exported.ok ? '' : exported.error.code, 'PARTITION_READ_FAILED');
  });

  it('fails the export on an event JSON cannot represent (A-05)', async () => {
    const { store } = storeHarness();
    store.seed(
      'experiment_journal',
      journalItem(TRIAL_PK, 'refund_provider', 1, { amount_minor: JSON.parse('1e400') as number }),
    );
    const exported = await exportJournals(store, EXPERIMENT_PLAN);
    assert.equal(exported.ok ? '' : exported.error.code, 'RECORD_NOT_REPRESENTABLE');
  });
});

describe('routeJournalItems', () => {
  it('refuses an item whose sort key names no planned source, quoting it bounded', () => {
    for (const sk of ['runner#i#000000000001', 'state#attempt#x', 'no-separator', `${'x'.repeat(400)}#1`]) {
      const routed = routeJournalItems([{ pk: TRIAL_PK, sk }], EXPERIMENT_PLAN);
      assert.equal(routed.ok ? '' : routed.error.code, 'JOURNAL_ITEM_UNROUTABLE', sk);
      assert.ok((routed.ok ? '' : routed.error.detail).length < 600);
    }
  });

  it('does not treat a caller-state prefix as state outside the caller journal', () => {
    const routed = routeJournalItems([{ pk: TRIAL_PK, sk: 'state#request#r' }], EXPERIMENT_PLAN);
    assert.equal(routed.ok, false);
  });

  it('does not resolve a source through an inherited name', () => {
    const routed = routeJournalItems([{ pk: TRIAL_PK, sk: 'constructor#i#000000000001' }], CALLER_PLAN);
    assert.equal(routed.ok, false);
  });
});
