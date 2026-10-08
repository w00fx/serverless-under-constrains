// Conformance of ScriptedPageReader (design §12.2): what it serves has the shapes the in-memory
// store (itself conformance-tested against DynamoDB semantics) serves — a point read of a present
// or absent item, a last page without a cursor, an empty partition as one empty consistent page,
// and a failed read as a bare code. Repeated cursors and hostile keys are what it adds: a broken
// store the collector must not loop on or trust.
//
// Sources (RK-17): [R-aws] §1.3 (`ConsistentRead: true` Query pages; a read is complete only when
// a page carries no `LastEvaluatedKey`), via the in-memory store's own DynamoDB conformance tests.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScriptedPageReader } from '../../../support/evidence-collection/scripted-page-reader.ts';
import { storeHarness } from '../../../support/durable-store/item-store-fixtures.ts';

const PK = 'run#trial';
const ITEM = { pk: PK, sk: 'tx#1', amount_minor: 10000 };

describe('ScriptedPageReader conformance', () => {
  it('point-reads a present and an absent item as the in-memory store does', async () => {
    const { store } = storeHarness();
    store.seed('ledger', ITEM);
    const reader = new ScriptedPageReader();
    reader.putItem('ledger', ITEM);
    for (const key of [
      { pk: PK, sk: 'tx#1' },
      { pk: PK, sk: 'tx#2' },
    ]) {
      assert.deepEqual(await reader.getConsistent('ledger', key), await store.getConsistent('ledger', key));
    }
    assert.deepEqual(await reader.getConsistent('control', { pk: PK, sk: 'tx#1' }), { ok: true, value: undefined });
  });

  it('serves a whole partition and an empty one as the in-memory store does', async () => {
    const { store } = storeHarness();
    store.seed('ledger', ITEM);
    const reader = new ScriptedPageReader();
    reader.scriptPage('ledger', PK, { items: [ITEM], consistent_read: true });
    assert.deepEqual(await reader.queryPartitionPage('ledger', PK), await store.queryPartitionPage('ledger', PK));
    assert.deepEqual(
      await reader.queryPartitionPage('ledger', 'run#other'),
      await store.queryPartitionPage('ledger', 'run#other'),
    );
  });

  it('fails a scripted read with the bare code, as the in-memory store reports a fault', async () => {
    const { store } = storeHarness();
    store.scriptReadFault('ThrottlingException', { operation: 'queryPartitionPage', table: 'ledger' });
    const reader = new ScriptedPageReader();
    reader.scriptPageFailure('ledger', PK, 'ThrottlingException');
    assert.deepEqual(await reader.queryPartitionPage('ledger', PK), await store.queryPartitionPage('ledger', PK));
  });

  it('serves scripted pages in order, per partition, recording each cursor asked with', async () => {
    const reader = new ScriptedPageReader();
    reader.scriptPage('ledger', PK, { items: [ITEM], next_cursor: 'c1', consistent_read: true });
    reader.scriptPage('ledger', PK, { items: [], next_cursor: 'c1', consistent_read: true });
    assert.equal((await reader.queryPartitionPage('ledger', PK)).ok, true);
    const repeated = await reader.queryPartitionPage('ledger', PK, 'c1');
    assert.deepEqual(repeated, { ok: true, value: { items: [], next_cursor: 'c1', consistent_read: true } });
    assert.deepEqual(reader.cursors(), [undefined, 'c1']);
  });
});
