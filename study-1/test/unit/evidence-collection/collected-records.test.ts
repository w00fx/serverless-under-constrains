// Shared collector mechanics (design §9.3; BR-RUA-033, BR-RUA-037, A-05): an item without its key,
// a whole strongly consistent partition, canonical record bytes, and the reason of a failed read.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  encodeRecordFile,
  encodeRecordLines,
  readFailure,
  readWholePartition,
  recordOfItem,
} from '../../../src/evidence-collection/collected-records.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { ledgerItem, TRIAL_PK } from '../../support/evidence-collection/collection-fixtures.ts';
import { ScriptedPageReader } from '../../support/evidence-collection/scripted-page-reader.ts';
import { storeHarness } from '../../support/durable-store/item-store-fixtures.ts';
import { DEEP_NESTING, parsedTower } from '../../support/kernel/deep-json.ts';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('recordOfItem', () => {
  it('drops the table key and keeps every other member', () => {
    assert.deepEqual(recordOfItem({ pk: 'p', sk: 's', state: 'ARMED', version: 1 }), { state: 'ARMED', version: 1 });
  });
});

describe('readWholePartition (strongly consistent, paged until no cursor)', () => {
  it('reads every page in sort-key order and counts the pages', async () => {
    const { store } = storeHarness(2);
    for (const serial of [3, 1, 2, 5, 4]) {
      store.seed('ledger', ledgerItem(TRIAL_PK, serial));
    }
    const read = await readWholePartition(store, 'ledger', TRIAL_PK);
    assert.ok(read.ok);
    assert.equal(read.value.page_count, 3);
    assert.deepEqual(
      read.value.items.map((item) => item.sk),
      [1, 2, 3, 4, 5].map((serial) => ledgerItem(TRIAL_PK, serial).sk),
    );
  });

  it('reads an empty partition as one empty page', async () => {
    const { store } = storeHarness();
    assert.deepEqual(await readWholePartition(store, 'ledger', TRIAL_PK), {
      ok: true,
      value: { items: [], page_count: 1 },
    });
  });

  it('fails with the page that could not be read', async () => {
    const { store } = storeHarness(1);
    store.seed('ledger', ledgerItem(TRIAL_PK, 1));
    store.scriptReadFault('ProvisionedThroughputExceededException', { operation: 'queryPartitionPage' });
    const read = await readWholePartition(store, 'ledger', TRIAL_PK);
    assert.equal(read.ok ? '' : read.error.code, 'PARTITION_READ_FAILED');
    assert.match(
      read.ok ? '' : read.error.detail,
      /ledger read of .* at page 1 failed with ProvisionedThroughputExceededException/,
    );
  });

  it('stops on a cursor the store already returned instead of looping', async () => {
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
    const read = await readWholePartition(reader, 'ledger', TRIAL_PK);
    assert.equal(read.ok ? '' : read.error.code, 'PARTITION_CURSOR_REPEATED');
    assert.deepEqual(reader.cursors(), [undefined, 'c1']);
  });
});

describe('record bytes (BR-RUA-033 canonical JSON, one newline)', () => {
  it('encodes one record file and JSONL lines canonically', () => {
    const file = encodeRecordFile({ b: 1, a: [true] }, 'subject');
    assert.equal(file.ok ? text(file.value) : '', '{"a":[true],"b":1}\n');
    const lines = encodeRecordLines([{ z: 1 }, { y: 'é' }], 'subject');
    assert.equal(lines.ok ? text(lines.value) : '', '{"z":1}\n{"y":"é"}\n');
    const empty = encodeRecordLines([], 'subject');
    assert.equal(empty.ok ? empty.value.length : -1, 0);
  });

  it('refuses a non-finite number instead of writing null (A-05)', () => {
    const infinite = JSON.parse('{"amount_minor":1e400}') as JsonValue;
    const file = encodeRecordFile(infinite, 'ledger_snapshot');
    assert.equal(file.ok ? '' : file.error.code, 'RECORD_NOT_REPRESENTABLE');
    const lines = encodeRecordLines([{ ok: 1 }, infinite], 'callerJournal');
    assert.match(lines.ok ? '' : lines.error.detail, /^callerJournal line 2 holds a value JSON cannot represent/);
  });

  it(`encodes a record nested ${String(DEEP_NESTING)} levels deep without throwing (A-05)`, () => {
    const file = encodeRecordFile({ deep: parsedTower('mixed', DEEP_NESTING) }, 'deep');
    assert.equal(file.ok, true);
  });

  it('keeps an inherited-looking member name as plain data', () => {
    const record = JSON.parse('{"__proto__":{"x":1},"constructor":"c"}') as JsonValue;
    const file = encodeRecordFile(record, 'subject');
    assert.equal(file.ok ? text(file.value) : '', '{"__proto__":{"x":1},"constructor":"c"}\n');
  });
});

describe('readFailure', () => {
  it('names the read, the target, the page and the failure code, bounded', () => {
    const reason = readFailure('LEDGER_READ_FAILED', 'ledger', 'r#t', { code: 'X'.repeat(500) }, 2);
    assert.equal(reason.code, 'LEDGER_READ_FAILED');
    assert.equal(reason.subject, 'BR-RUA-037');
    assert.match(reason.detail, /^ledger read of r#t at page 2 failed with X+…\[truncated\]; expected a successful/);
    assert.doesNotMatch(readFailure('C', 's', 't', { code: 'Y' }).detail, /at page/);
  });
});
