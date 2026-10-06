// Request validation shared by every DurableItemStore implementation (pure, a mutation target).
//
// DynamoDB rejects these requests with a ValidationException before applying anything, so a
// request that fails here is a definitive failure. Checking locally keeps the DynamoDB
// adapter and the in-memory emulator in agreement and never sends an unencodable value.
// Limits: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html
// (partition key ≤ 2048 bytes, sort key ≤ 1024 bytes, `IN` ≤ 100 operands) and
// https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html
// (1 to 100 actions, no two on the same item, ClientRequestToken 1 to 36 characters).
// Attribute values must also respect the nesting depth, item size and number range limits of
// `attribute-value-limits.ts` (added in WP-04 review round 1: without them the emulator applied
// writes the service refuses, and a deep value overflowed the call stack instead of failing).
// Port policy beyond DynamoDB: an increment is a safe integer. The study's counters only ever
// add whole numbers, and DynamoDB adds in decimal while JavaScript adds in binary floating
// point, so a fractional increment could leave the emulator and the service disagreeing.

import { isUuid4 } from '../record-contract/identifiers.ts';
import { itemSizeViolation, storableValueViolations } from './attribute-value-limits.ts';
import { KEY_ATTRIBUTES } from './item-store-port.ts';
import type { Condition, ItemKey, StoredItem, UpdateAction, WriteAction } from './item-store-port.ts';

export const MAX_TRANSACTION_ACTIONS = 100;
export const MAX_IN_OPERANDS = 100;
export const MAX_PARTITION_KEY_BYTES = 2048;
export const MAX_SORT_KEY_BYTES = 1024;

const encoder = new TextEncoder();

/**
 * Lists every reason this store refuses one write action: each documented DynamoDB rejection,
 * plus the safe-integer increment policy of the header. Empty when the action is valid. Its
 * recursion is bounded by the nesting limit, so it never throws on a deep value.
 *
 * @example
 * validateWriteAction({ kind: 'condition_check', table: 'control', key: { pk: '', sk: 'config' },
 *   condition: { kind: 'item_absent' } });
 * // ['action: pk is ""; expected a non-empty string of at most 2048 UTF-8 bytes']
 */
export function validateWriteAction(action: WriteAction, location = 'action'): readonly string[] {
  switch (action.kind) {
    case 'put':
      return [
        ...keyViolations(action.item, location),
        ...itemAttributeViolations(action.item, location),
        ...(action.condition === undefined ? [] : conditionViolations(action.condition, `${location}.condition`)),
      ];
    case 'update':
      return [
        ...keyViolations(action.key, location),
        ...updateViolations(action, location),
        ...conditionViolations(action.condition, `${location}.condition`),
      ];
    case 'condition_check':
      return [
        ...keyViolations(action.key, location),
        ...conditionViolations(action.condition, `${location}.condition`),
      ];
  }
}

/**
 * Lists every reason DynamoDB would reject a `TransactWriteItems` request; empty when valid.
 *
 * @example
 * validateTransaction([], token); // ['transaction has 0 actions; expected 1 to 100']
 */
export function validateTransaction(actions: readonly WriteAction[], clientRequestToken: string): readonly string[] {
  const violations: string[] = [];
  if (actions.length === 0 || actions.length > MAX_TRANSACTION_ACTIONS) {
    violations.push(
      `transaction has ${String(actions.length)} actions; expected 1 to ${String(MAX_TRANSACTION_ACTIONS)}`,
    );
  }
  if (!isUuid4(clientRequestToken)) {
    violations.push(
      `ClientRequestToken is ${JSON.stringify(clientRequestToken)}; expected a lowercase UUIDv4 (36 characters)`,
    );
  }
  const seen = new Map<string, number>();
  for (const [index, action] of actions.entries()) {
    const item = itemIdentity(action);
    const earlier = seen.get(item);
    if (earlier !== undefined) {
      violations.push(`actions[${String(index)}] targets the same item as actions[${String(earlier)}]: ${item}`);
    }
    seen.set(item, index);
    violations.push(...validateWriteAction(action, `actions[${String(index)}]`));
  }
  return violations;
}

/**
 * Names the item an action touches, as `<table> <pk> <sk>` with JSON-quoted keys.
 *
 * @example
 * itemIdentity({ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's' } }); // 'ledger "p" "s"'
 */
export function itemIdentity(action: WriteAction): string {
  const key = action.kind === 'put' ? action.item : action.key;
  return `${action.table} ${JSON.stringify(key.pk)} ${JSON.stringify(key.sk)}`;
}

/**
 * Lists every reason DynamoDB would reject a primary key; empty when it is valid. Reads use it
 * too, so an invalid key fails the same way in every implementation.
 *
 * @example
 * keyViolations({ pk: 'run#trial', sk: '' }, 'get');
 * // ['get: sk is ""; expected a non-empty string of at most 1024 UTF-8 bytes']
 */
export function keyViolations(key: ItemKey, location: string): readonly string[] {
  return [...partitionKeyViolations(key.pk, location), ...keyPartViolation('sk', key.sk, MAX_SORT_KEY_BYTES, location)];
}

/**
 * Lists every reason DynamoDB would reject a partition key value; empty when it is valid.
 *
 * @example
 * partitionKeyViolations('', 'query'); // ['query: pk is ""; expected a non-empty string of at most 2048 UTF-8 bytes']
 */
export function partitionKeyViolations(pk: string, location: string): readonly string[] {
  return keyPartViolation('pk', pk, MAX_PARTITION_KEY_BYTES, location);
}

// Keys are stored and ordered as UTF-8, so a lone surrogate (which UTF-8 cannot encode) would
// be stored as U+FFFD and no longer equal the key the caller holds.
function keyPartViolation(part: string, value: string, maxBytes: number, location: string): readonly string[] {
  const bytes = encoder.encode(value).length;
  if (bytes > 0 && bytes <= maxBytes && value.isWellFormed()) {
    return [];
  }
  const shown = bytes > maxBytes ? `${String(bytes)} UTF-8 bytes long` : JSON.stringify(value);
  return [
    `${location}: ${part} is ${shown}; expected a non-empty well-formed string of at most ${String(maxBytes)} UTF-8 bytes`,
  ];
}

function itemAttributeViolations(item: StoredItem, location: string): readonly string[] {
  const size = itemSizeViolation(item, `${location}.item`);
  return [
    ...Object.entries(item).flatMap(([name, value]) => [
      ...attributeNameViolation(name, location),
      ...storableValueViolations(value, `${location}.item.${name}`),
    ]),
    ...(size === undefined ? [] : [size]),
  ];
}

function updateViolations(action: UpdateAction, location: string): readonly string[] {
  const setNames = Object.keys(action.set);
  const incrementEntries = Object.entries(action.increment ?? {});
  const names = [...setNames, ...incrementEntries.map(([name]) => name)];
  const violations: string[] = [];
  if (names.length === 0) {
    violations.push(`${location}: update sets and increments nothing; expected at least one attribute`);
  }
  for (const name of names.filter((candidate) => (KEY_ATTRIBUTES as readonly string[]).includes(candidate))) {
    violations.push(`${location}: update changes key attribute ${JSON.stringify(name)}; expected non-key attributes`);
  }
  for (const [name] of incrementEntries.filter(([candidate]) => setNames.includes(candidate))) {
    violations.push(`${location}: attribute ${JSON.stringify(name)} is both set and incremented; expected one clause`);
  }
  violations.push(...names.flatMap((name) => attributeNameViolation(name, location)));
  for (const [name, value] of Object.entries(action.set)) {
    violations.push(...storableValueViolations(value, `${location}.set.${name}`));
  }
  for (const [name, value] of incrementEntries.filter(([, amount]) => !Number.isSafeInteger(amount))) {
    violations.push(
      `${location}.increment.${name}: ${String(value)} is not a safe integer; expected a safe integer increment`,
    );
  }
  // The updated item holds at least the key and the set attributes; the emulator checks the
  // full result against the existing item.
  const size = itemSizeViolation({ ...action.set, pk: action.key.pk, sk: action.key.sk }, `${location}.set`);
  return size === undefined ? violations : [...violations, size];
}

function conditionViolations(condition: Condition, location: string): readonly string[] {
  switch (condition.kind) {
    case 'item_absent':
      return [];
    case 'attribute_equals':
      return [
        ...attributeNameViolation(condition.name, location),
        ...(typeof condition.value === 'number' ? storableValueViolations(condition.value, `${location}.value`) : []),
      ];
    case 'attribute_in': {
      const count = condition.values.length;
      const countViolation =
        count === 0 || count > MAX_IN_OPERANDS
          ? [`${location}: attribute_in has ${String(count)} values; expected 1 to ${String(MAX_IN_OPERANDS)}`]
          : [];
      return [...attributeNameViolation(condition.name, location), ...countViolation];
    }
    case 'all':
      if (condition.conditions.length === 0) {
        return [`${location}: all has no conditions; expected at least one`];
      }
      return condition.conditions.flatMap((nested, index) =>
        conditionViolations(nested, `${location}.conditions[${String(index)}]`),
      );
  }
}

function attributeNameViolation(name: string, location: string): readonly string[] {
  return name === '' ? [`${location}: attribute name is ""; expected a non-empty attribute name`] : [];
}
