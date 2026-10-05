// DynamoDB adapter of the DurableItemStore port (design §5.3, §9.3). Thin by construction:
// each port method sends exactly one request that `dynamodb-requests.ts` planned and maps the
// response or error through the pure helpers. The client must be built with `maxAttempts: 1`
// (`dynamodb-client.ts`), so the SDK never retries a write behind the caller's back and all
// retry policy stays explicit in the callers (design §9.4, BR-RUA-033).

import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import type { Result } from '../../record-contract/primitives.ts';
import { classifyDynamoError, errorCode } from '../dynamo-error-classification.ts';
import {
  planGetItem,
  planQueryPage,
  planTransaction,
  planWrite,
  readGetItemOutput,
  readQueryOutput,
} from '../dynamodb-requests.ts';
import type { PlannedWrite, RefusedRequest, StoreTableNames } from '../dynamodb-requests.ts';
import type { DurableItemStore, QueryPage, StoredItem, StoreReadFailure, WriteOutcome } from '../item-store-port.ts';

/**
 * Binds the port to DynamoDB tables. Roles absent from `tables` fail with `TableNotConfigured`
 * before any request is sent.
 *
 * @example
 * const store = createDynamoDbItemStore({ caller_journal: env.SUC_TABLE_CALLER_JOURNAL }, createStoreDynamoDbClient());
 */
export function createDynamoDbItemStore(tables: StoreTableNames, client: DynamoDBClient): DurableItemStore {
  return {
    write: (action) => sendWrite(client, planWrite(tables, action)),
    transact: (actions, clientRequestToken) => sendWrite(client, planTransaction(tables, actions, clientRequestToken)),
    getConsistent: async (table, key): Promise<Result<StoredItem | undefined, StoreReadFailure>> => {
      const plan = planGetItem(tables, table, key);
      return plan.ok ? sendRead(() => client.send(new GetItemCommand(plan.value)), readGetItemOutput) : plan;
    },
    queryPartitionPage: async (table, pk, cursor): Promise<Result<QueryPage, StoreReadFailure>> => {
      const plan = planQueryPage(tables, table, pk, cursor);
      return plan.ok ? sendRead(() => client.send(new QueryCommand(plan.value)), readQueryOutput) : plan;
    },
  };
}

async function sendWrite(client: DynamoDBClient, plan: Result<PlannedWrite, RefusedRequest>): Promise<WriteOutcome> {
  if (!plan.ok) {
    return plan.error;
  }
  try {
    await sendPlannedWrite(client, plan.value);
    return { kind: 'applied' };
  } catch (error) {
    return classifyDynamoError(error);
  }
}

function sendPlannedWrite(client: DynamoDBClient, planned: PlannedWrite): Promise<unknown> {
  switch (planned.operation) {
    case 'PutItem':
      return client.send(new PutItemCommand(planned.input));
    case 'UpdateItem':
      return client.send(new UpdateItemCommand(planned.input));
    case 'TransactWriteItems':
      return client.send(new TransactWriteItemsCommand(planned.input));
  }
}

async function sendRead<O, T>(
  send: () => Promise<O>,
  read: (output: O) => Result<T, StoreReadFailure>,
): Promise<Result<T, StoreReadFailure>> {
  let output: O;
  try {
    output = await send();
  } catch (error) {
    return { ok: false, error: { code: errorCode(error) } };
  }
  return read(output);
}
