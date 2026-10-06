// Port call → DynamoDB request input and output → port result. The wire-level fields that the
// study relies on (ConsistentRead, ALL_OLD, ClientRequestToken) are asserted exactly.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  planGetItem,
  planQueryPage,
  planTransaction,
  planWrite,
  readGetItemOutput,
  readQueryOutput,
} from '../../../src/durable-store/dynamodb-requests.ts';
import type { StoreTableNames } from '../../../src/durable-store/dynamodb-requests.ts';
import type { WriteAction } from '../../../src/durable-store/item-store-port.ts';
import { encodePageCursor } from '../../../src/durable-store/page-cursor.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

const TABLES: StoreTableNames = {
  ledger: 'suc1-ab12cd34-ledger',
  control: 'suc1-ab12cd34-control',
  caller_journal: 'suc1-ab12cd34-caller-journal',
};
const TOKEN = '0b5e1c8a-3f2d-4e6b-9a7c-1d2e3f4a5b6c';
const PK = 'run#trial';

const ledgerPut: WriteAction = {
  kind: 'put',
  table: 'ledger',
  item: { pk: PK, sk: 'tx#1', amount_minor: 10000, currency: 'BRL' },
  condition: { kind: 'item_absent' },
};
const treatmentUpdate: WriteAction = {
  kind: 'update',
  table: 'control',
  key: { pk: PK, sk: 'treatment' },
  set: { state: 'COMMITTED_WAITING', provider_commit_id: TOKEN },
  increment: { version: 1 },
  condition: { kind: 'attribute_equals', name: 'state', value: 'ARMED' },
};

describe('planWrite', () => {
  it('plans a conditional PutItem with ALL_OLD and no empty value map', () => {
    assert.deepEqual(planWrite(TABLES, ledgerPut), {
      ok: true,
      value: {
        operation: 'PutItem',
        input: {
          TableName: 'suc1-ab12cd34-ledger',
          Item: { pk: { S: PK }, sk: { S: 'tx#1' }, amount_minor: { N: '10000' }, currency: { S: 'BRL' } },
          ConditionExpression: 'attribute_not_exists(#c0)',
          ExpressionAttributeNames: { '#c0': 'pk' },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
    });
  });

  it('plans an unconditional PutItem without any expression field', () => {
    assert.deepEqual(planWrite(TABLES, { kind: 'put', table: 'caller_journal', item: { pk: PK, sk: 'e#1' } }), {
      ok: true,
      value: {
        operation: 'PutItem',
        input: { TableName: 'suc1-ab12cd34-caller-journal', Item: { pk: { S: PK }, sk: { S: 'e#1' } } },
      },
    });
  });

  it('plans an UpdateItem whose condition and update placeholders never collide', () => {
    assert.deepEqual(planWrite(TABLES, treatmentUpdate), {
      ok: true,
      value: {
        operation: 'UpdateItem',
        input: {
          TableName: 'suc1-ab12cd34-control',
          Key: { pk: { S: PK }, sk: { S: 'treatment' } },
          UpdateExpression: 'SET #u0 = :u0, #u1 = :u1 ADD #u2 :u2',
          ConditionExpression: '#c0 = :c0',
          ExpressionAttributeNames: { '#c0': 'state', '#u0': 'provider_commit_id', '#u1': 'state', '#u2': 'version' },
          ExpressionAttributeValues: {
            ':c0': { S: 'ARMED' },
            ':u0': { S: TOKEN },
            ':u1': { S: 'COMMITTED_WAITING' },
            ':u2': { N: '1' },
          },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
    });
  });

  it('plans a single condition_check as a one-action TransactWriteItems without a token', () => {
    assert.deepEqual(
      planWrite(TABLES, {
        kind: 'condition_check',
        table: 'control',
        key: { pk: PK, sk: 'config' },
        condition: { kind: 'attribute_in', name: 'phase', values: ['READY'] },
      }),
      {
        ok: true,
        value: {
          operation: 'TransactWriteItems',
          input: {
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: 'suc1-ab12cd34-control',
                  Key: { pk: { S: PK }, sk: { S: 'config' } },
                  ConditionExpression: '#c0 IN (:c0)',
                  ExpressionAttributeNames: { '#c0': 'phase' },
                  ExpressionAttributeValues: { ':c0': { S: 'READY' } },
                  ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
                },
              },
            ],
          },
        },
      },
    );
  });

  it('refuses an invalid action before a table lookup, and an unconfigured role', () => {
    assert.deepEqual(planWrite({}, { kind: 'put', table: 'ledger', item: { pk: '', sk: 's' } }), {
      ok: false,
      error: { kind: 'definitive_failure', code: 'ValidationException' },
    });
    assert.deepEqual(planWrite({ control: 'c' }, ledgerPut), {
      ok: false,
      error: { kind: 'definitive_failure', code: 'TableNotConfigured' },
    });
  });
});

describe('planTransaction', () => {
  it('plans members in order with the caller token', () => {
    const plan = planTransaction(TABLES, [ledgerPut, treatmentUpdate], TOKEN);
    assert.ok(plan.ok);
    assert.equal(plan.value.operation, 'TransactWriteItems');
    assert.deepEqual(plan.value.input, {
      ClientRequestToken: TOKEN,
      TransactItems: [
        {
          Put: {
            TableName: 'suc1-ab12cd34-ledger',
            Item: { pk: { S: PK }, sk: { S: 'tx#1' }, amount_minor: { N: '10000' }, currency: { S: 'BRL' } },
            ConditionExpression: 'attribute_not_exists(#c0)',
            ExpressionAttributeNames: { '#c0': 'pk' },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          },
        },
        {
          Update: {
            TableName: 'suc1-ab12cd34-control',
            Key: { pk: { S: PK }, sk: { S: 'treatment' } },
            UpdateExpression: 'SET #u0 = :u0, #u1 = :u1 ADD #u2 :u2',
            ConditionExpression: '#c0 = :c0',
            ExpressionAttributeNames: { '#c0': 'state', '#u0': 'provider_commit_id', '#u1': 'state', '#u2': 'version' },
            ExpressionAttributeValues: {
              ':c0': { S: 'ARMED' },
              ':u0': { S: TOKEN },
              ':u1': { S: 'COMMITTED_WAITING' },
              ':u2': { N: '1' },
            },
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          },
        },
      ],
    });
  });

  it('plans a condition_check member as a ConditionCheck guarding the other writes', () => {
    const guard: WriteAction = {
      kind: 'condition_check',
      table: 'control',
      key: { pk: PK, sk: 'config' },
      condition: { kind: 'attribute_equals', name: 'phase', value: 'READY' },
    };
    const plan = planTransaction(TABLES, [guard, ledgerPut], TOKEN);
    assert.ok(plan.ok);
    assert.ok(plan.value.operation === 'TransactWriteItems');
    assert.deepEqual(plan.value.input.TransactItems?.[0], {
      ConditionCheck: {
        TableName: 'suc1-ab12cd34-control',
        Key: { pk: { S: PK }, sk: { S: 'config' } },
        ConditionExpression: '#c0 = :c0',
        ExpressionAttributeNames: { '#c0': 'phase' },
        ExpressionAttributeValues: { ':c0': { S: 'READY' } },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    });
    assert.equal(plan.value.input.TransactItems[1]?.Put?.TableName, 'suc1-ab12cd34-ledger');
  });

  it('refuses an invalid transaction and any unconfigured role', () => {
    assert.deepEqual(planTransaction(TABLES, [ledgerPut, ledgerPut], TOKEN), {
      ok: false,
      error: { kind: 'definitive_failure', code: 'ValidationException' },
    });
    assert.deepEqual(planTransaction({ ledger: 'l' }, [ledgerPut, treatmentUpdate], TOKEN), {
      ok: false,
      error: { kind: 'definitive_failure', code: 'TableNotConfigured' },
    });
  });
});

describe('planGetItem', () => {
  it('always reads strongly consistently', () => {
    assert.deepEqual(planGetItem(TABLES, 'control', { pk: PK, sk: 'treatment' }), {
      ok: true,
      value: {
        TableName: 'suc1-ab12cd34-control',
        Key: { pk: { S: PK }, sk: { S: 'treatment' } },
        ConsistentRead: true,
      },
    });
  });

  it('refuses an invalid key and an unconfigured role', () => {
    assert.deepEqual(planGetItem(TABLES, 'control', { pk: PK, sk: '' }), {
      ok: false,
      error: { code: 'ValidationException' },
    });
    assert.deepEqual(planGetItem(TABLES, 'trial_registry', { pk: PK, sk: 'active' }), {
      ok: false,
      error: { code: 'TableNotConfigured' },
    });
  });
});

describe('planQueryPage', () => {
  const firstPage = {
    TableName: 'suc1-ab12cd34-ledger',
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' },
    ExpressionAttributeValues: { ':pk': { S: PK } },
    ConsistentRead: true,
  };

  it('queries one partition strongly consistently, from the start or after the cursor key', () => {
    assert.deepEqual(planQueryPage(TABLES, 'ledger', PK), { ok: true, value: firstPage });
    assert.deepEqual(planQueryPage(TABLES, 'ledger', PK, encodePageCursor({ pk: PK, sk: 'tx#9' })), {
      ok: true,
      value: { ...firstPage, ExclusiveStartKey: { pk: { S: PK }, sk: { S: 'tx#9' } } },
    });
  });

  it('refuses an empty partition key, an unconfigured role and a foreign or malformed cursor', () => {
    assert.deepEqual(planQueryPage(TABLES, 'ledger', ''), { ok: false, error: { code: 'ValidationException' } });
    assert.deepEqual(planQueryPage(TABLES, 'coordination', PK), { ok: false, error: { code: 'TableNotConfigured' } });
    assert.deepEqual(planQueryPage(TABLES, 'ledger', PK, encodePageCursor({ pk: 'other', sk: 's' })), {
      ok: false,
      error: { code: 'InvalidCursor' },
    });
    assert.deepEqual(planQueryPage(TABLES, 'ledger', PK, '%%%'), { ok: false, error: { code: 'InvalidCursor' } });
  });
});

describe('readGetItemOutput', () => {
  it('maps a missing item to undefined and decodes a present one', () => {
    assert.deepEqual(readGetItemOutput({}), { ok: true, value: undefined });
    assert.deepEqual(readGetItemOutput({ Item: { pk: { S: 'p' }, sk: { S: 's' }, n: { N: '2' } } }), {
      ok: true,
      value: { pk: 'p', sk: 's', n: 2 },
    });
  });

  it('reports an undecodable item instead of guessing', () => {
    assert.deepEqual(readGetItemOutput({ Item: { pk: { S: 'p' }, sk: { S: 's' }, bin: { B: new Uint8Array() } } }), {
      ok: false,
      error: { code: 'UndecodableItem' },
    });
  });
});

describe('readQueryOutput', () => {
  it('returns a final page without a cursor', () => {
    assert.deepEqual(readQueryOutput({ Items: [{ pk: { S: 'p' }, sk: { S: 'a' } }] }), {
      ok: true,
      value: { items: [{ pk: 'p', sk: 'a' }], consistent_read: true },
    });
    assert.deepEqual(readQueryOutput({}), { ok: true, value: { items: [], consistent_read: true } });
  });

  it('turns LastEvaluatedKey into the next cursor, even on an empty page', () => {
    assert.deepEqual(readQueryOutput({ Items: [], LastEvaluatedKey: { pk: { S: 'p' }, sk: { S: 'z' } } }), {
      ok: true,
      value: { items: [], next_cursor: encodePageCursor({ pk: 'p', sk: 'z' }), consistent_read: true },
    });
  });

  it('reports an undecodable item or LastEvaluatedKey', () => {
    assert.deepEqual(readQueryOutput({ Items: [{ pk: { S: 'p' }, sk: { S: 'a' } }, { pk: { S: 'p' } }] }), {
      ok: false,
      error: { code: 'UndecodableItem' },
    });
    assert.deepEqual(readQueryOutput({ Items: [], LastEvaluatedKey: { pk: { S: 'p' }, sk: { N: '1' } } }), {
      ok: false,
      error: { code: 'UndecodableItem' },
    });
  });
});

describe('planning and reading stay total on deep or forged input (WP-04 review round 1)', () => {
  // 10,000 levels, parsed from JSON text without recursion: deeper than any recursive walk
  // could follow, as an untrusted reply or event might be.
  const deepAttribute = JSON.parse(`${'{"M":{"k":'.repeat(10_000)}{"N":"1"}${'}}'.repeat(10_000)}`) as never;
  const deepItem = { pk: { S: PK }, sk: { S: 'deep' }, deep: deepAttribute };
  const base64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

  it('refuses a deep item read from the service as UndecodableItem', () => {
    assert.deepEqual(readGetItemOutput({ Item: deepItem }), { ok: false, error: { code: 'UndecodableItem' } });
    assert.deepEqual(readQueryOutput({ Items: [deepItem] }), { ok: false, error: { code: 'UndecodableItem' } });
  });

  it('refuses a write with a deep value as a definitive ValidationException', () => {
    let deep: JsonValue = 1;
    for (let level = 0; level < 10_000; level += 1) {
      deep = [deep];
    }
    const put: WriteAction = { kind: 'put', table: 'ledger', item: { pk: PK, sk: 's', deep } };
    const refused = { ok: false, error: { kind: 'definitive_failure', code: 'ValidationException' } };
    assert.deepEqual(planWrite(TABLES, put), refused);
    assert.deepEqual(planTransaction(TABLES, [put], TOKEN), refused);
  });

  it('refuses a deeply nested or forged cursor as InvalidCursor', () => {
    const deepCursor = base64url(`{"pk":"${PK}","sk":"s","x":${'['.repeat(100_000)}${']'.repeat(100_000)}}`);
    assert.deepEqual(planQueryPage(TABLES, 'ledger', PK, deepCursor), { ok: false, error: { code: 'InvalidCursor' } });
    const emptySk = base64url(`{"pk":"${PK}","sk":""}`);
    assert.deepEqual(planQueryPage(TABLES, 'ledger', PK, emptySk), { ok: false, error: { code: 'InvalidCursor' } });
  });
});
