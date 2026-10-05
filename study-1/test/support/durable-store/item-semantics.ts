// DynamoDB item semantics the in-memory emulator reproduces (design §12.2 `InMemoryItemStore`).
// Each rule cites the documented behavior it emulates (RK-17):
// - Conditions: a comparison with a missing attribute is false, and operands compare with
//   their type, so the string '1' never equals the number 1
//   (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.OperatorsAndFunctions.html).
// - UpdateItem creates the item when none exists and the condition admits it; `ADD` treats a
//   missing number attribute as 0 and rejects a non-number one
//   (https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_UpdateItem.html,
//   https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.UpdateExpressions.html).
// - Query returns a partition in ascending sort-key order, and strings compare by the bytes of
//   their UTF-8 encoding
//   (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html).

import type { Condition, StoredItem, UpdateAction } from '../../../src/durable-store/item-store-port.ts';
import type { JsonValue, Result } from '../../../src/record-contract/primitives.ts';

/**
 * Evaluates a condition against the item as it is before the write.
 *
 * @example
 * conditionHolds({ kind: 'attribute_equals', name: 'state', value: 'ARMED' }, item); // true when item.state === 'ARMED'
 */
export function conditionHolds(condition: Condition, item: StoredItem | undefined): boolean {
  switch (condition.kind) {
    case 'item_absent':
      return item === undefined;
    case 'attribute_equals': {
      const current = ownAttribute(item, condition.name);
      return typeof current === typeof condition.value && current === condition.value;
    }
    case 'attribute_in': {
      const current = ownAttribute(item, condition.name);
      return typeof current === 'string' && condition.values.includes(current);
    }
    case 'all':
      return condition.conditions.every((nested) => conditionHolds(nested, item));
  }
}

/**
 * Computes the item after an update, or the reason DynamoDB would reject it.
 *
 * @example
 * applyUpdate({ pk: 'p', sk: 's', version: 1 }, { ..., set: { state: 'X' }, increment: { version: 1 } });
 * // { ok: true, value: { pk: 'p', sk: 's', version: 2, state: 'X' } }
 */
export function applyUpdate(existing: StoredItem | undefined, action: UpdateAction): Result<StoredItem, string> {
  const next: Record<string, JsonValue> = { ...(existing ?? action.key), ...action.set };
  for (const [name, amount] of Object.entries(action.increment ?? {})) {
    const current = ownAttribute(existing, name);
    if (current !== undefined && typeof current !== 'number') {
      return {
        ok: false,
        error: `ADD ${JSON.stringify(name)} meets ${JSON.stringify(current)}; expected a number or a missing attribute`,
      };
    }
    Object.defineProperty(next, name, {
      value: (current ?? 0) + amount,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ok: true, value: { ...next, pk: action.key.pk, sk: action.key.sk } };
}

/**
 * Orders sort keys like DynamoDB: by the bytes of their UTF-8 encoding.
 *
 * @example
 * ['\u{1F600}', '￿'].sort(compareUtf8); // ['￿', '\u{1F600}'] (code units would say the opposite)
 */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function ownAttribute(item: StoredItem | undefined, name: string): JsonValue | undefined {
  return item !== undefined && Object.hasOwn(item, name) ? item[name] : undefined;
}
