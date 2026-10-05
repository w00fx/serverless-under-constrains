// UpdateAction → DynamoDB UpdateExpression (pure, a mutation target; design §15.4).
//
// `set` attributes become one `SET` clause and `increment` attributes one `ADD` clause.
// `ADD` treats a missing number attribute as zero, so a counter needs no initialization
// (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html).
// Attributes are emitted in code-unit order so the expression does not depend on object
// property order (BR-RUA-034). Placeholders use the `u` prefix (see `condition-expression.ts`).

import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import { encodeAttributeValue } from './attribute-value-codec.ts';
import type { ExpressionParts } from './condition-expression.ts';
import type { JsonValue } from '../record-contract/primitives.ts';
import type { UpdateAction } from './item-store-port.ts';

/**
 * Builds the UpdateExpression of an update. Callers validate first: at least one attribute,
 * no key attribute, and no attribute in both clauses.
 *
 * @example
 * toUpdateExpression({ state: 'COMMITTED_WAITING' }, { version: 1 });
 * // { expression: 'SET #u0 = :u0 ADD #u1 :u1', names: { '#u0': 'state', '#u1': 'version' },
 * //   values: { ':u0': { S: 'COMMITTED_WAITING' }, ':u1': { N: '1' } } }
 */
export function toUpdateExpression(
  set: UpdateAction['set'],
  increment: UpdateAction['increment'] = {},
): ExpressionParts {
  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const placeholderPair = (name: string, value: JsonValue): readonly [string, string] => {
    const index = String(Object.keys(names).length);
    names[`#u${index}`] = name;
    values[`:u${index}`] = encodeAttributeValue(value, `$.${name}`);
    return [`#u${index}`, `:u${index}`];
  };
  const setTerms = sortedEntries(set).map(([name, value]) => placeholderPair(name, value).join(' = '));
  const addTerms = sortedEntries(increment).map(([name, value]) => placeholderPair(name, value).join(' '));
  const clauses = [clause('SET', setTerms), clause('ADD', addTerms)].filter((text) => text !== '');
  return { expression: clauses.join(' '), names, values };
}

// Keys of one record are unique, so the comparator never sees two equal names.
function sortedEntries<T>(record: Readonly<Record<string, T>>): readonly (readonly [string, T])[] {
  return Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1));
}

function clause(keyword: string, terms: readonly string[]): string {
  return terms.length === 0 ? '' : `${keyword} ${terms.join(', ')}`;
}
