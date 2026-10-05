// Port call → DynamoDB request input, and DynamoDB output → port result (pure, a mutation
// target). The `aws/` adapter only sends what this module plans, so every decision about the
// wire format is unit-testable without the SDK (design §1 principle 5).
//
// Load-bearing request fields (design §9.3, §12.2 `RecordingDynamoDbClient`):
// - every read sets `ConsistentRead: true` (base tables only, never a GSI, [R-aws] §1.3);
// - every conditional write sets `ReturnValuesOnConditionCheckFailure: ALL_OLD`;
// - a transaction carries the caller's `ClientRequestToken` (F-1).

import type {
  AttributeValue,
  ConditionCheck,
  GetItemCommandInput,
  Put,
  PutItemCommandInput,
  QueryCommandInput,
  TransactWriteItem,
  TransactWriteItemsCommandInput,
  Update,
  UpdateItemCommandInput,
} from '@aws-sdk/client-dynamodb';

import type { Result } from '../record-contract/primitives.ts';
import { decodeStoredItem, encodeAttributeMap } from './attribute-value-codec.ts';
import { toConditionExpression } from './condition-expression.ts';
import type { ExpressionParts } from './condition-expression.ts';
import { STORE_CODES } from './item-store-port.ts';
import type {
  ConditionCheckAction,
  Condition,
  ItemKey,
  PutAction,
  QueryPage,
  StoredItem,
  StoreReadFailure,
  TableRole,
  UpdateAction,
  WriteAction,
} from './item-store-port.ts';
import { decodePageCursor, encodePageCursor } from './page-cursor.ts';
import { toUpdateExpression } from './update-expression.ts';
import {
  keyViolations,
  partitionKeyViolations,
  validateTransaction,
  validateWriteAction,
} from './write-action-validation.ts';

/** Physical table names per role. A role a function's IAM does not allow is simply absent. */
export type StoreTableNames = Readonly<Partial<Record<TableRole, string>>>;

export type PlannedWrite =
  | { readonly operation: 'PutItem'; readonly input: PutItemCommandInput }
  | { readonly operation: 'UpdateItem'; readonly input: UpdateItemCommandInput }
  | { readonly operation: 'TransactWriteItems'; readonly input: TransactWriteItemsCommandInput };

/** A request refused before sending: nothing was applied. */
export interface RefusedRequest {
  readonly kind: 'definitive_failure';
  readonly code: string;
}

interface ConditionFields {
  readonly ConditionExpression: string;
  readonly ExpressionAttributeNames: Record<string, string>;
  readonly ExpressionAttributeValues?: Record<string, AttributeValue>;
  readonly ReturnValuesOnConditionCheckFailure: 'ALL_OLD';
}

/**
 * Plans one write. A single `condition_check` becomes a one-action `TransactWriteItems`,
 * the only DynamoDB API that checks a condition without writing.
 *
 * @example
 * const plan = planWrite({ caller_journal: 'suc1-ab12cd34-caller-journal' }, putAction);
 * if (plan.ok) await client.send(new PutItemCommand(plan.value.input));
 */
export function planWrite(tables: StoreTableNames, action: WriteAction): Result<PlannedWrite, RefusedRequest> {
  if (validateWriteAction(action).length > 0) {
    return { ok: false, error: { kind: 'definitive_failure', code: STORE_CODES.validation } };
  }
  const tableName = tables[action.table];
  if (tableName === undefined) {
    return { ok: false, error: { kind: 'definitive_failure', code: STORE_CODES.tableNotConfigured } };
  }
  switch (action.kind) {
    case 'put':
      return { ok: true, value: { operation: 'PutItem', input: putInput(tableName, action) } };
    case 'update':
      return { ok: true, value: { operation: 'UpdateItem', input: updateInput(tableName, action) } };
    case 'condition_check':
      return {
        ok: true,
        value: {
          operation: 'TransactWriteItems',
          input: { TransactItems: [{ ConditionCheck: conditionCheckInput(tableName, action) }] },
        },
      };
  }
}

/**
 * Plans an atomic `TransactWriteItems` with the caller's idempotency token.
 *
 * @example
 * const plan = planTransaction(tables, [ledgerPut, journalPut, treatmentUpdate], providerCommitId);
 */
export function planTransaction(
  tables: StoreTableNames,
  actions: readonly WriteAction[],
  clientRequestToken: string,
): Result<PlannedWrite, RefusedRequest> {
  if (validateTransaction(actions, clientRequestToken).length > 0) {
    return { ok: false, error: { kind: 'definitive_failure', code: STORE_CODES.validation } };
  }
  const members: TransactWriteItem[] = [];
  for (const action of actions) {
    const tableName = tables[action.table];
    if (tableName === undefined) {
      return { ok: false, error: { kind: 'definitive_failure', code: STORE_CODES.tableNotConfigured } };
    }
    members.push(transactMember(tableName, action));
  }
  return {
    ok: true,
    value: {
      operation: 'TransactWriteItems',
      input: { TransactItems: members, ClientRequestToken: clientRequestToken },
    },
  };
}

/**
 * Plans a strongly consistent `GetItem`.
 *
 * @example
 * planGetItem(tables, 'control', { pk: partition, sk: 'treatment' });
 */
export function planGetItem(
  tables: StoreTableNames,
  table: TableRole,
  key: ItemKey,
): Result<GetItemCommandInput, StoreReadFailure> {
  if (keyViolations(key, 'get').length > 0) {
    return { ok: false, error: { code: STORE_CODES.validation } };
  }
  const tableName = tables[table];
  if (tableName === undefined) {
    return { ok: false, error: { code: STORE_CODES.tableNotConfigured } };
  }
  return { ok: true, value: { TableName: tableName, Key: encodeKey(key), ConsistentRead: true } };
}

/**
 * Plans one strongly consistent `Query` page of a partition, resuming after the cursor's key.
 *
 * @example
 * planQueryPage(tables, 'ledger', partition, page.next_cursor);
 */
export function planQueryPage(
  tables: StoreTableNames,
  table: TableRole,
  pk: string,
  cursor?: string,
): Result<QueryCommandInput, StoreReadFailure> {
  if (partitionKeyViolations(pk, 'query').length > 0) {
    return { ok: false, error: { code: STORE_CODES.validation } };
  }
  const tableName = tables[table];
  if (tableName === undefined) {
    return { ok: false, error: { code: STORE_CODES.tableNotConfigured } };
  }
  const start = cursor === undefined ? undefined : decodePageCursor(cursor, pk);
  if (start?.ok === false) {
    return { ok: false, error: { code: STORE_CODES.invalidCursor } };
  }
  const input: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' },
    ExpressionAttributeValues: { ':pk': { S: pk } },
    ConsistentRead: true,
  };
  return { ok: true, value: start === undefined ? input : { ...input, ExclusiveStartKey: encodeKey(start.value) } };
}

/**
 * Reads a `GetItem` output: the decoded item, or `undefined` when no item exists.
 *
 * @example
 * readGetItemOutput(await client.send(new GetItemCommand(input)));
 */
export function readGetItemOutput(output: {
  readonly Item?: Record<string, AttributeValue> | undefined;
}): Result<StoredItem | undefined, StoreReadFailure> {
  if (output.Item === undefined) {
    return { ok: true, value: undefined };
  }
  const item = decodeStoredItem(output.Item);
  return item.ok ? item : { ok: false, error: { code: STORE_CODES.undecodableItem } };
}

/**
 * Reads a `Query` output as a page; `LastEvaluatedKey` becomes the next cursor.
 *
 * @example
 * readQueryOutput(await client.send(new QueryCommand(input)));
 */
export function readQueryOutput(output: {
  readonly Items?: readonly Record<string, AttributeValue>[] | undefined;
  readonly LastEvaluatedKey?: Record<string, AttributeValue> | undefined;
}): Result<QueryPage, StoreReadFailure> {
  const items: StoredItem[] = [];
  for (const raw of output.Items ?? []) {
    const item = decodeStoredItem(raw);
    if (!item.ok) {
      return { ok: false, error: { code: STORE_CODES.undecodableItem } };
    }
    items.push(item.value);
  }
  if (output.LastEvaluatedKey === undefined) {
    return { ok: true, value: { items, consistent_read: true } };
  }
  const lastKey = decodeStoredItem(output.LastEvaluatedKey);
  if (!lastKey.ok) {
    return { ok: false, error: { code: STORE_CODES.undecodableItem } };
  }
  return { ok: true, value: { items, next_cursor: encodePageCursor(lastKey.value), consistent_read: true } };
}

function transactMember(tableName: string, action: WriteAction): TransactWriteItem {
  switch (action.kind) {
    case 'put':
      return { Put: putInput(tableName, action) };
    case 'update':
      return { Update: updateInput(tableName, action) };
    case 'condition_check':
      return { ConditionCheck: conditionCheckInput(tableName, action) };
  }
}

function putInput(tableName: string, action: PutAction): Put {
  return { TableName: tableName, Item: encodeAttributeMap(action.item), ...conditionFields(action.condition) };
}

function updateInput(tableName: string, action: UpdateAction): Update {
  const update = toUpdateExpression(action.set, action.increment);
  return {
    TableName: tableName,
    Key: encodeKey(action.key),
    UpdateExpression: update.expression,
    ...mergedExpressionFields(toConditionExpression(action.condition), update),
  };
}

function conditionCheckInput(tableName: string, action: ConditionCheckAction): ConditionCheck {
  return {
    TableName: tableName,
    Key: encodeKey(action.key),
    ...mergedExpressionFields(toConditionExpression(action.condition), undefined),
  };
}

function conditionFields(condition: Condition | undefined): Partial<ConditionFields> {
  return condition === undefined ? {} : mergedExpressionFields(toConditionExpression(condition), undefined);
}

// DynamoDB rejects an empty ExpressionAttributeValues map, so it is omitted when no value
// placeholder is used (an `item_absent` condition alone).
function mergedExpressionFields(condition: ExpressionParts, update: ExpressionParts | undefined): ConditionFields {
  const names = { ...condition.names, ...update?.names };
  const values = { ...condition.values, ...update?.values };
  const fields: ConditionFields = {
    ConditionExpression: condition.expression,
    ExpressionAttributeNames: names,
    ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
  };
  return Object.keys(values).length === 0 ? fields : { ...fields, ExpressionAttributeValues: values };
}

function encodeKey(key: ItemKey): Record<string, AttributeValue> {
  return { pk: { S: key.pk }, sk: { S: key.sk } };
}
