// Design §12.5 for the journal routing (design §9.3; BR-RUA-033): over arbitrary sort keys — real
// sources, caller state, unknown and inherited names, keys without a separator — routing either
// refuses the partition naming an unroutable key, or puts every non-state item in exactly the one
// file whose sources include its key's source, in partition order, with nothing dropped.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { StoredItem } from '../../../src/durable-store/item-store-port.ts';
import {
  CALLER_STATE_SORT_KEY_PREFIX,
  routeJournalItems,
  unitJournalPlans,
} from '../../../src/evidence-collection/journal-export.ts';
import type { JournalExportPlan } from '../../../src/evidence-collection/journal-export.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const PK = 'run#trial';
const PLANS = unitJournalPlans(PK);

const sourceName = fc.constantFrom(
  'conventional_caller',
  'durable_caller',
  'probe_caller',
  'refund_provider',
  'treatment_controller',
  'runner',
  'state',
  'constructor',
  '__proto__',
  'toString',
  '',
);

const sortKey = fc.oneof(
  fc
    .tuple(sourceName, fc.string({ maxLength: 8 }), fc.nat({ max: 999 }))
    .map(([source, instance, sequence]) => `${source}#${instance}#${String(sequence).padStart(12, '0')}`),
  fc.constantFrom(`${CALLER_STATE_SORT_KEY_PREFIX}attempt#a`, `${CALLER_STATE_SORT_KEY_PREFIX}request#r`),
  fc.string({ maxLength: 20 }),
);

function sourceOf(key: string): string {
  const separator = key.indexOf('#');
  return separator === -1 ? key : key.slice(0, separator);
}

function isState(plan: JournalExportPlan, key: string): boolean {
  return plan.table === 'caller_journal' && key.startsWith(CALLER_STATE_SORT_KEY_PREFIX);
}

function routable(plan: JournalExportPlan, key: string): boolean {
  return plan.routes.some((route) => (route.sources as readonly string[]).includes(sourceOf(key)));
}

describe('routeJournalItems', () => {
  it('routes every event once, in order, or refuses the partition for an unroutable key', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PLANS), fc.array(sortKey, { maxLength: 30 }), (plan, keys) => {
        const items: StoredItem[] = keys.map((sk, index) => ({ pk: PK, sk, position: index }));
        const routed = routeJournalItems(items, plan);
        const events = keys.filter((key) => !isState(plan, key));
        const unroutable = events.find((key) => !routable(plan, key));
        if (unroutable !== undefined) {
          assert.ok(!routed.ok);
          assert.equal(routed.error.code, 'JOURNAL_ITEM_UNROUTABLE');
          return;
        }
        assert.ok(routed.ok, routed.ok ? '' : routed.error.detail);
        assert.deepEqual(
          routed.value.map((bucket) => bucket.file),
          plan.routes.map((route) => route.file),
        );
        for (const bucket of routed.value) {
          const expected = items
            .filter(
              (item) => !isState(plan, item.sk) && (bucket.sources as readonly string[]).includes(sourceOf(item.sk)),
            )
            .map((item) => item['position']);
          assert.deepEqual(
            bucket.events.map((event) => event['position']),
            expected,
          );
        }
        const routedCount = routed.value.reduce((total, bucket) => total + bucket.events.length, 0);
        assert.equal(routedCount, events.length);
      }),
      fuzzParameters(),
    );
  });
});
