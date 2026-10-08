// DynamoDB attribute-value limits shared by the codec, request validation and the in-memory
// emulator (pure, a mutation target). Sharing them keeps the DynamoDB adapter and the emulator
// in agreement (design §12.2, RK-17); every limit cites the page that documents it:
// - nesting: "DynamoDB supports nested attributes up to 32 levels deep"
//   (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html);
// - item size: at most 400 KB, attribute names included
//   (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/ServiceQuotas.html),
//   estimated with the sizing rules of
//   https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html;
// - numbers: zero, or a magnitude from 1E-130 to 9.9999999999999999999999999999999999999E+125
//   (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html).
//   The upper bound needs no check of its own: every double of magnitude 2^53 or more is an
//   integer, and the store already refuses integers outside the safe-integer range.
//
// Depth convention (WP-04 review round 1): a value's depth is the number of lists and maps that
// enclose it inside one attribute. An attribute holding a scalar has depth 0; the item's own
// top-level map is not counted. A list or map may sit at depth 0 to 31, so one attribute holds
// at most 32 levels of lists and maps. AWS does not document how it counts the levels, so this
// reading is an interpretation. The decoder and the validator use the same bound, so whatever
// this store writes it can also read back.

import type { JsonValue } from '../record-contract/primitives.ts';
import { memberPath } from './attribute-path.ts';

export const MAX_NESTING_DEPTH = 32;
export const MAX_ITEM_BYTES = 400 * 1024;
export const MIN_NUMBER_MAGNITUDE = 1e-130;
/** The expected shape that every refused number names. */
export const STORABLE_NUMBER_SHAPE = 'a finite number, safe when integral, zero or of magnitude at least 1E-130';

// The documented sizing rules: 1 byte for null and Boolean, 3 bytes of overhead for each list
// or map, and 1 more byte for each list or map element.
const SCALAR_FLAG_BYTES = 1;
const CONTAINER_OVERHEAD_BYTES = 3;
const ELEMENT_OVERHEAD_BYTES = 1;

/**
 * Tells why DynamoDB could not store a number exactly, or `undefined` when it can.
 *
 * @example
 * unencodableNumberReason(Number.NaN); // 'NaN is not a finite number'
 * unencodableNumberReason(2 ** 53); // '9007199254740992 is an integer outside the safe-integer range'
 * unencodableNumberReason(5e-324); // '5e-324 is nonzero with a magnitude below 1E-130'
 */
export function unencodableNumberReason(value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return `${String(value)} is not a finite number`;
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return `${String(value)} is an integer outside the safe-integer range`;
  }
  if (value !== 0 && Math.abs(value) < MIN_NUMBER_MAGNITUDE) {
    return `${String(value)} is nonzero with a magnitude below 1E-130`;
  }
  return undefined;
}

/**
 * Describes a list or map nested past the limit, for an error message.
 *
 * @example
 * nestingViolation('$.a[0]'); // '$.a[0] nests deeper than 32 levels; expected at most 32 levels of lists and maps (DynamoDB limit)'
 */
export function nestingViolation(path: string): string {
  return `${path} nests deeper than ${String(MAX_NESTING_DEPTH)} levels; expected at most ${String(MAX_NESTING_DEPTH)} levels of lists and maps (DynamoDB limit)`;
}

/**
 * Lists every reason DynamoDB would refuse one attribute value: a number it cannot store, or
 * lists and maps nested past 32 levels. It never descends past the limit, so its recursion is
 * bounded however deep the value is.
 *
 * @example
 * storableValueViolations({ amounts: [1, Number.NaN] }, 'action.item.x');
 * // ['action.item.x.amounts[1]: NaN is not a finite number; expected a finite number, …']
 */
export function storableValueViolations(value: JsonValue, path: string): readonly string[] {
  return valueViolations(value, path, 0);
}

/**
 * Estimates an item's size as DynamoDB counts it: attribute names plus values, with the
 * documented overheads. A number counts 1 byte per two significant digits plus 1 byte. The
 * page calls that rule approximate, so an item close to 400 KB may be judged a little
 * differently by the service. Iterative, so a value of any depth is sized without recursion.
 *
 * @example
 * estimatedItemBytes({ pk: 'p', sk: 's', n: 10000 }); // 9: names 2 + 2 + 1, values 1 + 1 + 2
 */
export function estimatedItemBytes(attributes: Readonly<Record<string, JsonValue>>): number {
  let total = 0;
  for (const [name, value] of Object.entries(attributes)) {
    total += utf8Bytes(name) + estimatedValueBytes(value);
  }
  return total;
}

/**
 * Estimates one attribute value's size with the same rules as `estimatedItemBytes` (used for
 * expression substitution values too). Iterative, so a value of any depth is sized.
 *
 * @example
 * estimatedValueBytes(['ab', true]); // 8: list 3, one byte per element 2, 'ab' 2, true 1
 */
export function estimatedValueBytes(value: JsonValue): number {
  let total = 0;
  const pending: JsonValue[] = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    total += ownBytes(next);
    for (const [name, nested] of containerEntries(next)) {
      total += utf8Bytes(name) + ELEMENT_OVERHEAD_BYTES;
      pending.push(nested);
    }
  }
  return total;
}

/**
 * The UTF-8 length of a string, the unit of every DynamoDB size limit.
 *
 * @example
 * utf8Bytes('é'); // 2
 */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Describes an item over the size limit, or `undefined` when it fits.
 *
 * @example
 * itemSizeViolation({ pk: 'p', sk: 's', blob: 'x'.repeat(500_000) }, 'action.item');
 * // 'action.item is about 500010 bytes; expected at most 409600 bytes (DynamoDB item size limit)'
 */
export function itemSizeViolation(attributes: Readonly<Record<string, JsonValue>>, path: string): string | undefined {
  const bytes = estimatedItemBytes(attributes);
  return bytes <= MAX_ITEM_BYTES
    ? undefined
    : `${path} is about ${String(bytes)} bytes; expected at most ${String(MAX_ITEM_BYTES)} bytes (DynamoDB item size limit)`;
}

function valueViolations(value: JsonValue, path: string, depth: number): readonly string[] {
  if (typeof value === 'number') {
    const reason = unencodableNumberReason(value);
    return reason === undefined ? [] : [`${path}: ${reason}; expected ${STORABLE_NUMBER_SHAPE}`];
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  if (depth >= MAX_NESTING_DEPTH) {
    return [nestingViolation(path)];
  }
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).flatMap((element, index) =>
      valueViolations(element, `${path}[${String(index)}]`, depth + 1),
    );
  }
  return Object.entries(value).flatMap(([name, nested]) => valueViolations(nested, memberPath(path, name), depth + 1));
}

// A list's or map's members as [name, value] pairs, where a list element has the empty name
// because only map keys add name bytes; a scalar has none.
function containerEntries(value: JsonValue): readonly (readonly [string, JsonValue])[] {
  if (Array.isArray(value)) {
    return (value as readonly JsonValue[]).map((element) => ['', element] as const);
  }
  return typeof value === 'object' && value !== null ? Object.entries(value) : [];
}

function ownBytes(value: JsonValue): number {
  if (typeof value === 'string') {
    return utf8Bytes(value);
  }
  if (typeof value === 'number') {
    return Math.ceil(significantDigits(value) / 2) + 1;
  }
  return value === null || typeof value === 'boolean' ? SCALAR_FLAG_BYTES : CONTAINER_OVERHEAD_BYTES;
}

// Leading and trailing zeros are trimmed (CapacityUnitCalculations.html); zero keeps one digit.
function significantDigits(value: number): number {
  const [mantissa = ''] = String(Math.abs(value)).split('e');
  const digits = mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return Math.max(digits.length, 1);
}
