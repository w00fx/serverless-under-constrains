// Condition → DynamoDB ConditionExpression (pure, a mutation target; design §15.4).
//
// Every attribute name goes through an ExpressionAttributeNames placeholder, so reserved
// words such as `state` or `version` never break an expression, and every value goes through
// an ExpressionAttributeValues placeholder. Condition placeholders use the `c` prefix and
// update placeholders the `u` prefix (`update-expression.ts`), so one request can carry both
// without collisions. DynamoDB rejects unused placeholders, so each one is used exactly once.
// Syntax: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html
// Rendering is iterative (WP-04 review round 2): an `all` nested 100,000 levels deep, or
// 100,000 members wide, renders to a long string, which validation then refuses by the 4 KB
// expression limit, instead of overflowing the call stack.

import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import type { Condition } from './item-store-port.ts';
import { pushEach } from './push-each.ts';

export interface ExpressionParts {
  readonly expression: string;
  readonly names: Readonly<Record<string, string>>;
  readonly values: Readonly<Record<string, AttributeValue>>;
}

interface PlaceholderAllocator {
  readonly names: Record<string, string>;
  readonly values: Record<string, AttributeValue>;
  nameCount: number;
  valueCount: number;
}

/**
 * Builds the ConditionExpression of a write. `item_absent` tests the partition key, which
 * every stored item has, so it holds exactly when no item exists under the key.
 *
 * @example
 * toConditionExpression({ kind: 'attribute_equals', name: 'state', value: 'ARMED' });
 * // { expression: '#c0 = :c0', names: { '#c0': 'state' }, values: { ':c0': { S: 'ARMED' } } }
 */
export function toConditionExpression(condition: Condition): ExpressionParts {
  const allocator: PlaceholderAllocator = { names: {}, values: {}, nameCount: 0, valueCount: 0 };
  const expression = render(condition, allocator);
  return { expression, names: allocator.names, values: allocator.values };
}

/**
 * Encodes a scalar comparison operand with its JSON type, so `'1'` and `1` never compare equal.
 *
 * @example
 * scalarAttributeValue(true); // { BOOL: true }
 */
export function scalarAttributeValue(value: string | number | boolean): AttributeValue {
  if (typeof value === 'string') {
    return { S: value };
  }
  return typeof value === 'number' ? { N: String(value) } : { BOOL: value };
}

// A pending piece of the expression: literal text, or a condition still to render. Pieces are
// popped in output order, so placeholders are numbered left to right.
type RenderPiece = { readonly text: string } | Condition;

function render(condition: Condition, allocator: PlaceholderAllocator): string {
  let expression = '';
  const pending: RenderPiece[] = [condition];
  for (let piece = pending.pop(); piece !== undefined; piece = pending.pop()) {
    if ('text' in piece) {
      expression += piece.text;
      continue;
    }
    if (piece.kind === 'all') {
      pushEach(pending, allPieces(piece.conditions));
      continue;
    }
    expression += renderLeaf(piece, allocator);
  }
  return expression;
}

// `(c0) AND (c1) AND …`, reversed for the stack.
function allPieces(conditions: readonly Condition[]): readonly RenderPiece[] {
  const pieces: RenderPiece[] = [];
  for (const [index, nested] of conditions.entries()) {
    pieces.push({ text: index === 0 ? '(' : ' AND (' }, nested, { text: ')' });
  }
  return pieces.reverse();
}

function renderLeaf(condition: Exclude<Condition, { readonly kind: 'all' }>, allocator: PlaceholderAllocator): string {
  switch (condition.kind) {
    case 'item_absent':
      return `attribute_not_exists(${namePlaceholder(allocator, 'pk')})`;
    case 'attribute_equals':
      return `${namePlaceholder(allocator, condition.name)} = ${valuePlaceholder(allocator, scalarAttributeValue(condition.value))}`;
    case 'attribute_in': {
      const name = namePlaceholder(allocator, condition.name);
      const operands = condition.values.map((value) => valuePlaceholder(allocator, { S: value }));
      return `${name} IN (${operands.join(', ')})`;
    }
  }
}

function namePlaceholder(allocator: PlaceholderAllocator, name: string): string {
  const placeholder = `#c${String(allocator.nameCount)}`;
  allocator.nameCount += 1;
  allocator.names[placeholder] = name;
  return placeholder;
}

function valuePlaceholder(allocator: PlaceholderAllocator, value: AttributeValue): string {
  const placeholder = `:c${String(allocator.valueCount)}`;
  allocator.valueCount += 1;
  allocator.values[placeholder] = value;
  return placeholder;
}
