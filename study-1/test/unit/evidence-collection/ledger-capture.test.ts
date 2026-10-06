// The independent ledger read (BR-RUA-005, BR-RUA-034, AC-RUA-007): strongly consistent pages until
// no cursor, every item kept, every page recorded with the cursors that bound it, and an
// incomplete read recorded as incomplete rather than padded or dropped.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { captureLedgerSnapshot } from '../../../src/evidence-collection/ledger-capture.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import {
  assertValidRecord,
  collectionClock,
  ledgerItem,
  PROBE_PK,
  PROBE_SCOPE,
  TRIAL_PK,
  TRIAL_SCOPE,
} from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedPageReader } from '../../support/evidence-collection/scripted-page-reader.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';

function pagesOf(record: JsonObject): JsonValue {
  return record['pages'] ?? null;
}

describe('captureLedgerSnapshot', () => {
  it('reads every page and records each with its cursors (complete read)', async () => {
    const { store } = storeHarness(2);
    for (const serial of [1, 2, 3]) {
      store.seed('ledger', ledgerItem(TRIAL_PK, serial));
    }
    const ledger = await captureLedgerSnapshot(store, TRIAL_SCOPE, collectionClock());
    assertValidRecord(ledger.record, 'ledger_snapshot');
    assert.equal(ledger.complete, true);
    assert.equal(ledger.transaction_count, 3);
    assert.deepEqual(ledger.failures, []);
    const pages = pagesOf(ledger.record) as readonly JsonObject[];
    assert.deepEqual(
      pages.map((page) => [page['page_number'], page['item_count'], 'start_cursor' in page, 'next_cursor' in page]),
      [
        [1, 2, false, true],
        [2, 1, true, false],
      ],
    );
    assert.equal(pages[1]?.['start_cursor'], pages[0]?.['next_cursor']);
    assert.equal(ledger.record['writer'], 'evidence_collector');
    assert.equal(ledger.record['consistent_read'], true);
    assert.equal(ledger.record['partition_key'], TRIAL_PK);
    assert.equal(ledger.record['captured_at'], '2026-10-05T12:20:00.000Z');
    assert.deepEqual(
      ledger.record['transactions'],
      [1, 2, 3].map((serial) => {
        const { pk: _pk, sk: _sk, ...transaction } = ledgerItem(TRIAL_PK, serial);
        return transaction;
      }),
    );
  });

  it('records an empty partition as one empty, complete page', async () => {
    const { store } = storeHarness();
    const ledger = await captureLedgerSnapshot(store, PROBE_SCOPE, collectionClock());
    assertValidRecord(ledger.record, 'probe ledger_snapshot');
    assert.deepEqual(pagesOf(ledger.record), [{ page_number: 1, item_count: 0 }]);
    assert.equal(ledger.record['partition_key'], PROBE_PK);
    assert.equal('trial_id' in ledger.record, false);
  });

  it('never truncates, whatever the size (BR-RUA-034)', async () => {
    const { store } = storeHarness(7);
    for (let serial = 1; serial <= 250; serial += 1) {
      store.seed('ledger', ledgerItem(TRIAL_PK, serial));
    }
    const ledger = await captureLedgerSnapshot(store, TRIAL_SCOPE, collectionClock());
    assert.equal(ledger.transaction_count, 250);
    assert.equal((ledger.record['transactions'] as readonly JsonValue[]).length, 250);
    assert.equal((pagesOf(ledger.record) as readonly JsonValue[]).length, 36);
    assertValidRecord(ledger.record);
  });

  it('records a failed page as an incomplete read that keeps the pages before it (AC-RUA-007)', async () => {
    const reader = new ScriptedPageReader();
    reader.scriptPage('ledger', TRIAL_PK, {
      items: [ledgerItem(TRIAL_PK, 1)],
      next_cursor: 'c1',
      consistent_read: true,
    });
    reader.scriptPageFailure('ledger', TRIAL_PK, 'InternalServerError');
    const ledger = await captureLedgerSnapshot(reader, TRIAL_SCOPE, collectionClock());
    assertValidRecord(ledger.record, 'incomplete ledger_snapshot');
    assert.equal(ledger.complete, false);
    assert.equal(ledger.record['complete'], false);
    assert.equal(ledger.transaction_count, 1);
    assert.deepEqual(pagesOf(ledger.record), [{ page_number: 1, item_count: 1, next_cursor: 'c1' }]);
    assert.deepEqual(
      ledger.failures.map((failure) => failure.code),
      ['LEDGER_READ_FAILED'],
    );
    assert.match(ledger.failures[0]?.detail ?? '', /at page 2 failed with InternalServerError/);
  });

  it('records a failed first page as incomplete with no page', async () => {
    const { store } = storeHarness();
    store.scriptReadFault('AccessDeniedException');
    const ledger = await captureLedgerSnapshot(store, TRIAL_SCOPE, collectionClock());
    assert.equal(ledger.complete, false);
    assert.deepEqual(pagesOf(ledger.record), []);
    assertValidRecord(ledger.record);
  });

  it('stops on a repeated cursor and records the read incomplete (BR-RUA-005)', async () => {
    const reader = new ScriptedPageReader();
    reader.scriptPage('ledger', TRIAL_PK, {
      items: [ledgerItem(TRIAL_PK, 1)],
      next_cursor: 'c1',
      consistent_read: true,
    });
    reader.scriptPage('ledger', TRIAL_PK, {
      items: [ledgerItem(TRIAL_PK, 2)],
      next_cursor: 'c1',
      consistent_read: true,
    });
    const ledger = await captureLedgerSnapshot(reader, TRIAL_SCOPE, collectionClock());
    assert.equal(ledger.complete, false);
    assert.equal(ledger.transaction_count, 2);
    assert.deepEqual(
      ledger.failures.map((failure) => [failure.code, failure.subject]),
      [['LEDGER_CURSOR_REPEATED', 'BR-RUA-005']],
    );
    assert.deepEqual(pagesOf(ledger.record), [
      { page_number: 1, item_count: 1, next_cursor: 'c1' },
      { page_number: 2, item_count: 1, start_cursor: 'c1', next_cursor: 'c1' },
    ]);
  });

  it('keeps a malformed transaction for ingestion to judge instead of dropping it', async () => {
    const { store } = storeHarness();
    store.seed('ledger', { pk: TRIAL_PK, sk: 'tx#odd', amount_minor: JSON.parse('1e400') as number, toString: 'x' });
    const ledger = await captureLedgerSnapshot(store, TRIAL_SCOPE, collectionClock());
    assert.equal(ledger.transaction_count, 1);
    assert.deepEqual(ledger.record['transactions'], [{ amount_minor: Infinity, toString: 'x' }]);
  });
});
