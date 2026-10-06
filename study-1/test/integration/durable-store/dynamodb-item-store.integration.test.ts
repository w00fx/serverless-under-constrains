// The DynamoDB adapter over a real SDK client (built by the production factory) whose network
// is replaced by RecordingDynamoDbClient. Proves the wire requests the study depends on and the
// mapping of real SDK responses and errors to port outcomes, with no hidden retries.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDynamoDbItemStore } from '../../../src/durable-store/aws/dynamodb-item-store.ts';
import type { StoreTableNames } from '../../../src/durable-store/dynamodb-requests.ts';
import type { StoredItem, WriteAction } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { RecordingDynamoDbClient } from '../../support/durable-store/aws/recording-dynamodb-client.ts';
import type { ScriptedDynamoDbResponse } from '../../support/durable-store/aws/recording-dynamodb-client.ts';

const TABLES: StoreTableNames = {
  ledger: 'suc1-ab12cd34-ledger',
  experiment_journal: 'suc1-ab12cd34-experiment-journal',
  control: 'suc1-ab12cd34-control',
};
const TOKEN = '5f0c6a1e-2b3d-4c5e-8f9a-0b1c2d3e4f5a' as Uuid4;
const PK = 'run#trial';

const ledgerPut: WriteAction = {
  kind: 'put',
  table: 'ledger',
  item: { pk: PK, sk: 'tx#1', amount_minor: 10000 },
  condition: { kind: 'item_absent' },
};
const treatmentUpdate: WriteAction = {
  kind: 'update',
  table: 'control',
  key: { pk: PK, sk: 'treatment' },
  set: { state: 'COMMITTED_WAITING' },
  increment: { version: 1 },
  condition: { kind: 'attribute_equals', name: 'state', value: 'ARMED' },
};

function setup(): {
  readonly recording: RecordingDynamoDbClient;
  readonly store: ReturnType<typeof createDynamoDbItemStore>;
} {
  const recording = new RecordingDynamoDbClient();
  return { recording, store: createDynamoDbItemStore(TABLES, recording.client) };
}

describe('createDynamoDbItemStore writes', () => {
  it('sends one conditional PutItem with ALL_OLD and reports applied', async () => {
    const { recording, store } = setup();
    recording.respondWithSuccess();
    assert.deepEqual(await store.write(ledgerPut), { kind: 'applied' });
    assert.deepEqual(recording.calls(), [
      {
        operation: 'PutItem',
        input: {
          TableName: 'suc1-ab12cd34-ledger',
          Item: { pk: { S: PK }, sk: { S: 'tx#1' }, amount_minor: { N: '10000' } },
          ConditionExpression: 'attribute_not_exists(#c0)',
          ExpressionAttributeNames: { '#c0': 'pk' },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
        hostname: 'dynamodb.us-east-1.amazonaws.com',
        attempt_header: 'attempt=1; max=1',
      },
    ]);
  });

  it('maps a ConditionalCheckFailedException to condition_failed with the ALL_OLD item', async () => {
    const { recording, store } = setup();
    recording.respondWithServiceError('ConditionalCheckFailedException', {
      message: 'The conditional request failed',
      Item: { pk: { S: PK }, sk: { S: 'treatment' }, state: { S: 'CONSUMED' }, version: { N: '4' } },
    });
    assert.deepEqual(await store.write(treatmentUpdate), {
      kind: 'condition_failed',
      failed_action_index: 0,
      existing: { pk: PK, sk: 'treatment', state: 'CONSUMED', version: 4 },
    });
    assert.equal(recording.calls()[0]?.operation, 'UpdateItem');
  });

  it('sends a transaction with the caller ClientRequestToken and maps cancellation reasons', async () => {
    const { recording, store } = setup();
    recording.respondWithServiceError('TransactionCanceledException', {
      Message: 'Transaction cancelled, please refer cancellation reasons for specific reasons',
      CancellationReasons: [
        { Code: 'None' },
        {
          Code: 'ConditionalCheckFailed',
          Message: 'The conditional request failed',
          Item: { pk: { S: PK }, sk: { S: 'treatment' }, state: { S: 'TIMEOUT_SIGNALLED' } },
        },
      ],
    });
    assert.deepEqual(await store.transact([ledgerPut, treatmentUpdate], TOKEN), {
      kind: 'condition_failed',
      failed_action_index: 1,
      existing: { pk: PK, sk: 'treatment', state: 'TIMEOUT_SIGNALLED' },
    });
    const [call] = recording.calls();
    assert.ok(call !== undefined);
    assert.equal(call.operation, 'TransactWriteItems');
    const input = call.input as { readonly ClientRequestToken: string; readonly TransactItems: readonly unknown[] };
    assert.equal(input.ClientRequestToken, TOKEN);
    assert.equal(input.TransactItems.length, 2);
  });

  it('reports an applied transaction and an idempotency mismatch', async () => {
    const { recording, store } = setup();
    recording.respondWithSuccess();
    recording.respondWithServiceError('IdempotentParameterMismatchException', { message: 'mismatch' });
    assert.deepEqual(await store.transact([ledgerPut], TOKEN), { kind: 'applied' });
    assert.deepEqual(await store.transact([treatmentUpdate], TOKEN), {
      kind: 'definitive_failure',
      code: 'IdempotentParameterMismatchException',
    });
  });

  it('sends a single condition_check as one ConditionCheck transaction', async () => {
    const { recording, store } = setup();
    recording.respondWithSuccess();
    const check: WriteAction = {
      kind: 'condition_check',
      table: 'control',
      key: { pk: PK, sk: 'config' },
      condition: { kind: 'item_absent' },
    };
    assert.deepEqual(await store.write(check), { kind: 'applied' });
    const input = recording.calls()[0]?.input as { readonly TransactItems: readonly unknown[] };
    assert.deepEqual(input.TransactItems, [
      {
        ConditionCheck: {
          TableName: 'suc1-ab12cd34-control',
          Key: { pk: { S: PK }, sk: { S: 'config' } },
          ConditionExpression: 'attribute_not_exists(#c0)',
          ExpressionAttributeNames: { '#c0': 'pk' },
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        },
      },
    ]);
  });

  it('never retries: a server fault, a lost connection, a garbled reply and an in-progress token are ambiguous after one request', async () => {
    const cases: readonly [ScriptedDynamoDbResponse, string][] = [
      [
        { kind: 'service_error', status: 500, type: 'InternalServerError', body: { message: 'internal' } },
        'InternalServerError',
      ],
      [
        { kind: 'network_error', error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) },
        'ECONNRESET',
      ],
      [{ kind: 'raw', status: 503, body: '<html>unavailable</html>' }, 'SyntaxError'],
      [
        {
          kind: 'service_error',
          status: 400,
          type: 'TransactionInProgressException',
          body: { Message: 'in progress' },
        },
        'TransactionInProgressException',
      ],
    ];
    for (const [response, code] of cases) {
      const { recording, store } = setup();
      recording.respondWith(response);
      assert.deepEqual(await store.transact([ledgerPut], TOKEN), { kind: 'ambiguous', code });
      assert.equal(recording.calls().length, 1, code);
    }
  });

  it('never retries a throttle either: it is definitive after one request', async () => {
    const { recording, store } = setup();
    recording.respondWithServiceError('ProvisionedThroughputExceededException', { message: 'slow down' });
    assert.deepEqual(await store.write(ledgerPut), {
      kind: 'definitive_failure',
      code: 'ProvisionedThroughputExceededException',
    });
    assert.equal(recording.calls().length, 1);
  });

  it('refuses invalid requests and unconfigured roles without sending anything', async () => {
    const { recording, store } = setup();
    assert.deepEqual(await store.write({ kind: 'put', table: 'ledger', item: { pk: PK, sk: '' } }), {
      kind: 'definitive_failure',
      code: 'ValidationException',
    });
    assert.deepEqual(await store.transact([ledgerPut, ledgerPut], TOKEN), {
      kind: 'definitive_failure',
      code: 'ValidationException',
    });
    assert.deepEqual(await store.write({ kind: 'put', table: 'caller_journal', item: { pk: PK, sk: 'e' } }), {
      kind: 'definitive_failure',
      code: 'TableNotConfigured',
    });
    assert.deepEqual(await store.getConsistent('trial_registry', { pk: PK, sk: 'active' }), {
      ok: false,
      error: { code: 'TableNotConfigured' },
    });
    assert.deepEqual(await store.queryPartitionPage('ledger', PK, 'not-a-cursor!'), {
      ok: false,
      error: { code: 'InvalidCursor' },
    });
    assert.deepEqual(recording.calls(), []);
  });
});

describe('createDynamoDbItemStore reads', () => {
  it('reads strongly consistently and maps a missing item to undefined', async () => {
    const { recording, store } = setup();
    recording.respondWithSuccess({ Item: { pk: { S: PK }, sk: { S: 'treatment' }, state: { S: 'ARMED' } } });
    recording.respondWithSuccess({});
    assert.deepEqual(await store.getConsistent('control', { pk: PK, sk: 'treatment' }), {
      ok: true,
      value: { pk: PK, sk: 'treatment', state: 'ARMED' },
    });
    assert.deepEqual(await store.getConsistent('control', { pk: PK, sk: 'absent' }), { ok: true, value: undefined });
    assert.deepEqual(
      recording.calls().map((call) => [call.operation, call.input]),
      [
        [
          'GetItem',
          { TableName: 'suc1-ab12cd34-control', Key: { pk: { S: PK }, sk: { S: 'treatment' } }, ConsistentRead: true },
        ],
        [
          'GetItem',
          { TableName: 'suc1-ab12cd34-control', Key: { pk: { S: PK }, sk: { S: 'absent' } }, ConsistentRead: true },
        ],
      ],
    );
  });

  it('reports a read error by name', async () => {
    const { recording, store } = setup();
    recording.respondWithServiceError('ResourceNotFoundException', { message: 'no table' });
    recording.respondWith({ kind: 'network_error', error: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    assert.deepEqual(await store.getConsistent('control', { pk: PK, sk: 'x' }), {
      ok: false,
      error: { code: 'ResourceNotFoundException' },
    });
    assert.deepEqual(await store.queryPartitionPage('ledger', PK), { ok: false, error: { code: 'ECONNRESET' } });
  });

  it('pages a partition until LastEvaluatedKey is absent, resuming from each cursor', async () => {
    const { recording, store } = setup();
    const tx = (n: number): Record<string, { readonly S: string } | { readonly N: string }> => ({
      pk: { S: PK },
      sk: { S: `tx#${String(n)}` },
      amount_minor: { N: '10000' },
    });
    recording.respondWithSuccess({ Items: [tx(1), tx(2)], LastEvaluatedKey: { pk: { S: PK }, sk: { S: 'tx#2' } } });
    recording.respondWithSuccess({ Items: [], LastEvaluatedKey: { pk: { S: PK }, sk: { S: 'tx#2' } } });
    recording.respondWithSuccess({ Items: [tx(3)] });
    const collected: StoredItem[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await store.queryPartitionPage('ledger', PK, cursor);
      assert.ok(page.ok);
      assert.equal(page.value.consistent_read, true);
      collected.push(...page.value.items);
      cursor = page.value.next_cursor;
      pages += 1;
    } while (cursor !== undefined);
    assert.equal(pages, 3);
    assert.deepEqual(
      collected.map((item) => item.sk),
      ['tx#1', 'tx#2', 'tx#3'],
    );
    const inputs = recording.calls().map((call) => call.input as Record<string, unknown>);
    assert.deepEqual(inputs[0], {
      TableName: 'suc1-ab12cd34-ledger',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': { S: PK } },
      ConsistentRead: true,
    });
    assert.deepEqual(inputs[1]?.['ExclusiveStartKey'], { pk: { S: PK }, sk: { S: 'tx#2' } });
    assert.deepEqual(inputs[2]?.['ExclusiveStartKey'], { pk: { S: PK }, sk: { S: 'tx#2' } });
    assert.equal(recording.pendingResponseCount(), 0);
  });

  it('reports an undecodable item from the service', async () => {
    const { recording, store } = setup();
    recording.respondWithSuccess({ Items: [{ pk: { S: PK }, sk: { S: 'a' }, s: { SS: ['x'] } }] });
    assert.deepEqual(await store.queryPartitionPage('ledger', PK), { ok: false, error: { code: 'UndecodableItem' } });
  });
});

describe('createDynamoDbItemStore on deep or forged input (WP-04 review round 1)', () => {
  it('refuses a 20,000-level write locally with an outcome, sending nothing', async () => {
    const { recording, store } = setup();
    let deep: JsonValue = 'x';
    for (let level = 0; level < 20_000; level += 1) {
      deep = [deep];
    }
    const put: WriteAction = { kind: 'put', table: 'ledger', item: { pk: PK, sk: 'deep', deep } };
    const refused = { kind: 'definitive_failure', code: 'ValidationException' };
    assert.deepEqual(await store.write(put), refused);
    assert.deepEqual(await store.transact([put], TOKEN), refused);
    assert.deepEqual(recording.calls(), []);
  });

  it('keeps a certain condition failure when the ALL_OLD item nests past 32 levels', async () => {
    const { recording, store } = setup();
    // 40 levels: past the store's limit, yet shallow enough for the SDK's own deserializer.
    const deepItem = `{"pk":{"S":"${PK}"},"sk":{"S":"tx#1"},"d":${'{"L":['.repeat(40)}{"S":"x"}${']}'.repeat(40)}}`;
    recording.respondWith({
      kind: 'raw',
      status: 400,
      body: `{"__type":"com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException","Item":${deepItem}}`,
    });
    assert.deepEqual(await store.write(ledgerPut), { kind: 'condition_failed', failed_action_index: 0 });
    recording.respondWith({ kind: 'raw', status: 200, body: `{"Items":[${deepItem}]}` });
    assert.deepEqual(await store.queryPartitionPage('ledger', PK), { ok: false, error: { code: 'UndecodableItem' } });
  });

  it('refuses a forged cursor with an empty sort key before sending, as the emulator does', async () => {
    const { recording, store } = setup();
    const forged = Buffer.from(`{"pk":"${PK}","sk":""}`, 'utf8').toString('base64url');
    assert.deepEqual(await store.queryPartitionPage('ledger', PK, forged), {
      ok: false,
      error: { code: 'InvalidCursor' },
    });
    assert.deepEqual(recording.calls(), []);
  });
});
