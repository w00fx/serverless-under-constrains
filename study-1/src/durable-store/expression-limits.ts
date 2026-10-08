// DynamoDB expression-parameter and transaction limits (pure, a mutation target). Added in
// WP-04 review round 2: without them the emulator applied writes the service refuses with a
// ValidationException. Source, section "Expression parameters" and "DynamoDB transactions" of
// https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html (retrieved
// 2026-10-05):
// - "The maximum length of any expression string is 4 KB";
// - "The maximum number of operators or functions allowed in a single expression is 300". A
//   comparator (`=`), a logical keyword (`AND`), `IN` and a function (`attribute_not_exists`)
//   each count one; the `=` of a `SET` action is assignment syntax and does not count, so the
//   update expressions this store builds (`SET` and `ADD` only) hold no operator;
// - "The maximum length of all substitution variables in an expression is 2 MB. This is the sum
//   of the lengths of all ExpressionAttributeNames and ExpressionAttributeValues". One request
//   carries one map of each for its condition and update expressions, so the sum is per request;
//   names count their UTF-8 bytes and values their size by the item sizing rules (an estimate);
// - "A transaction cannot contain more than 4 MB of data", read as the attribute data its puts
//   and updates write (API_TransactWriteItems.html: "The aggregate size of the items in the
//   transaction"), estimated with the item sizing rules.
// Every helper here is iterative and appends through `pushEach`, so a condition of any depth or
// width is measured without recursion or a spread call; the validator calls
// `expressionLimitViolations` only on an action that is otherwise valid.

import type { JsonValue } from '../record-contract/primitives.ts';
import { estimatedItemBytes, estimatedValueBytes, utf8Bytes } from './attribute-value-limits.ts';
import { toConditionExpression } from './condition-expression.ts';
import type { ExpressionParts } from './condition-expression.ts';
import type { Condition, UpdateAction, WriteAction } from './item-store-port.ts';
import { pushEach } from './push-each.ts';
import { toUpdateExpression } from './update-expression.ts';

export const MAX_EXPRESSION_BYTES = 4 * 1024;
export const MAX_EXPRESSION_OPERATORS = 300;
export const MAX_SUBSTITUTION_BYTES = 2 * 1024 * 1024;
export const MAX_TRANSACTION_DATA_BYTES = 4 * 1024 * 1024;

// Each `all` level wraps its member in two parentheses, and the shortest member renders to 9
// bytes (`#c0 = :c0`), so a condition nested deeper than this cannot fit in 4 KB.
const SHORTEST_LEAF_BYTES = 9;
/** The deepest `all` nesting whose expression can still fit the 4 KB limit. */
export const MAX_CONDITION_NESTING = Math.floor((MAX_EXPRESSION_BYTES - SHORTEST_LEAF_BYTES) / 2);

/**
 * The deepest `all` nesting in a condition: 0 for a lone comparison, 1 for comparisons inside
 * one `all`. Iterative, so a condition of any depth or width is measured.
 *
 * @example
 * conditionNesting({ kind: 'all', conditions: [{ kind: 'item_absent' }] }); // 1
 */
export function conditionNesting(condition: Condition): number {
  let deepest = 0;
  const pending: [Condition, number][] = [[condition, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [node, depth] = next;
    deepest = Math.max(deepest, depth);
    if (node.kind === 'all') {
      pushEach(
        pending,
        node.conditions.map((nested): [Condition, number] => [nested, depth + 1]),
      );
    }
  }
  return deepest;
}

/**
 * Counts the operators and functions of a condition's expression as DynamoDB does: one per
 * comparison, `IN` or `attribute_not_exists`, plus one `AND` between members of an `all`.
 *
 * @example
 * conditionOperatorCount({ kind: 'all', conditions: [{ kind: 'item_absent' }, { kind: 'item_absent' }] }); // 3
 */
export function conditionOperatorCount(condition: Condition): number {
  let count = 0;
  for (const node of conditionNodes(condition)) {
    count += node.kind === 'all' ? Math.max(node.conditions.length - 1, 0) : 1;
  }
  return count;
}

/**
 * Lists every reason DynamoDB would refuse the expressions of one otherwise valid action: an
 * expression longer than 4 KB, more than 300 operators, or substitution variables over 2 MB.
 *
 * @example
 * expressionLimitViolations(checkWith301Operators, 'action');
 * // ['action.condition has 301 operators or functions; expected at most 300 (DynamoDB expression limit)']
 */
export function expressionLimitViolations(action: WriteAction, location: string): readonly string[] {
  const violations = [
    ...(action.condition === undefined ? [] : conditionLimitViolations(action.condition, `${location}.condition`)),
    ...(action.kind === 'update'
      ? expressionLengthViolation(toUpdateExpression(action.set, action.increment), `${location}.update`)
      : []),
  ];
  const substitution = substitutionBytes(action);
  if (substitution > MAX_SUBSTITUTION_BYTES) {
    violations.push(
      `${location} has about ${String(substitution)} bytes of expression attribute names and values; expected at most ${String(MAX_SUBSTITUTION_BYTES)} bytes (DynamoDB expression limit)`,
    );
  }
  return violations;
}

/**
 * Estimates the attribute data a transaction writes: each put's item and each update's key,
 * set and increment attributes; a condition check writes none.
 *
 * @example
 * transactionDataBytes([{ kind: 'put', table: 'ledger', item: { pk: 'p', sk: 's' } }]); // 6
 */
export function transactionDataBytes(actions: readonly WriteAction[]): number {
  let total = 0;
  for (const action of actions) {
    total += actionDataBytes(action);
  }
  return total;
}

function actionDataBytes(action: WriteAction): number {
  switch (action.kind) {
    case 'put':
      return estimatedItemBytes(action.item);
    case 'update':
      return estimatedItemBytes({ ...action.set, ...action.increment, pk: action.key.pk, sk: action.key.sk });
    case 'condition_check':
      return 0;
  }
}

function expressionLengthViolation(parts: ExpressionParts, location: string): readonly string[] {
  const bytes = utf8Bytes(parts.expression);
  return bytes <= MAX_EXPRESSION_BYTES
    ? []
    : [
        `${location} expression is ${String(bytes)} bytes long; expected at most ${String(MAX_EXPRESSION_BYTES)} bytes (DynamoDB expression limit)`,
      ];
}

function conditionLimitViolations(condition: Condition, location: string): readonly string[] {
  const operators = conditionOperatorCount(condition);
  return [
    ...expressionLengthViolation(toConditionExpression(condition), location),
    ...(operators > MAX_EXPRESSION_OPERATORS
      ? [
          `${location} has ${String(operators)} operators or functions; expected at most ${String(MAX_EXPRESSION_OPERATORS)} (DynamoDB expression limit)`,
        ]
      : []),
  ];
}

// The names and values every placeholder of the request substitutes: the condition's operands
// plus, for an update, its set and increment attributes.
function substitutionBytes(action: WriteAction): number {
  const conditionParts =
    action.condition === undefined ? { names: [], values: [] } : conditionOperands(action.condition);
  const updateParts = action.kind === 'update' ? updateOperands(action) : { names: [], values: [] };
  let total = 0;
  for (const name of [...conditionParts.names, ...updateParts.names]) {
    total += utf8Bytes(name);
  }
  for (const value of [...conditionParts.values, ...updateParts.values]) {
    total += estimatedValueBytes(value);
  }
  return total;
}

interface SubstitutedOperands {
  readonly names: readonly string[];
  readonly values: readonly JsonValue[];
}

function updateOperands(action: UpdateAction): SubstitutedOperands {
  const increment = action.increment ?? {};
  return {
    names: [...Object.keys(action.set), ...Object.keys(increment)],
    values: [...Object.values(action.set), ...Object.values(increment)],
  };
}

function conditionOperands(condition: Condition): SubstitutedOperands {
  const names: string[] = [];
  const values: JsonValue[] = [];
  for (const node of conditionNodes(condition)) {
    if (node.kind === 'item_absent') {
      names.push('pk');
    }
    if (node.kind === 'attribute_equals') {
      names.push(node.name);
      values.push(node.value);
    }
    if (node.kind === 'attribute_in') {
      names.push(node.name);
      pushEach(values, node.values);
    }
  }
  return { names, values };
}

// Every node of a condition, iteratively, in no particular order.
function conditionNodes(condition: Condition): readonly Condition[] {
  const nodes: Condition[] = [];
  const pending: Condition[] = [condition];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    nodes.push(next);
    if (next.kind === 'all') {
      pushEach(pending, next.conditions);
    }
  }
  return nodes;
}
