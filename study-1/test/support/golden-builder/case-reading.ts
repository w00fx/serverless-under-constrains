// Total readers over an untrusted case value: what a `*.case.ts` module exports is checked field
// by field before anything is built from it, and every problem is reported with its location, the
// offending value and the expected shape (Owner amendment A-05). Objects are read through their
// own data properties only, so an inherited member (`toString`, `__proto__`) or an accessor is
// never mistaken for a declared field; every reader returns problems instead of throwing.

import { canonicalJsonIfRepresentable } from '../../../src/record-contract/canonical-json.ts';
import { boundedJsonText, boundedText } from '../../../src/record-contract/json-value.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';

/** Problems found so far, each prefixed with the location it was found at. */
export type Problems = string[];

/** The own data properties of a closed object, or undefined after reporting why it is not one. */
export type FieldReader = ReadonlyMap<string, unknown>;

/**
 * Reads `value` as an object with exactly the given required and optional keys (a closed shape,
 * like every record root under Owner amendment A-07). Reports a missing required key, an unknown
 * or symbol key and an accessor property.
 *
 * @example
 * const fields = readObject(value, 'case', ['case_id'], ['plan'], problems);
 * fields?.get('case_id');
 */
export function readObject(
  value: unknown,
  at: string,
  required: readonly string[],
  optional: readonly string[],
  problems: Problems,
): FieldReader | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`${at} is ${describeValue(value)}; expected an object`);
    return undefined;
  }
  const fields = new Map<string, unknown>();
  if (Object.getOwnPropertySymbols(value).length > 0) {
    problems.push(`${at} has symbol-keyed members; expected string keys only`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!required.includes(key) && !optional.includes(key)) {
      const allowed = [...required, ...optional];
      problems.push(
        `${at} has unknown member ${boundedJsonText(key)}; expected ${allowed.length === 0 ? 'no members' : `only ${allowed.join(', ')}`}`,
      );
    } else if ('value' in descriptor) {
      fields.set(key, descriptor.value);
    } else {
      problems.push(`${at}.${key} is an accessor; expected a data property`);
    }
  }
  for (const key of required.filter((name) => !fields.has(name))) {
    problems.push(`${at}.${key} is missing; expected it to be present`);
  }
  return fields;
}

/**
 * Reads a member with `read` when it is present. An absent required member was already reported
 * missing by `readObject`, so it adds no second problem here.
 *
 * @example
 * const caseId = readMember(fields, 'case_id', (value) => readString(value, 'case.case_id', CASE_ID_PATTERN, problems));
 */
export function readMember<T>(
  fields: FieldReader,
  key: string,
  read: (value: unknown) => T | undefined,
): T | undefined {
  return fields.has(key) ? read(fields.get(key)) : undefined;
}

/**
 * Reads an array's items; an array with a hole or an accessor item is rejected.
 *
 * @example
 * readArray(value, 'case.ac_ids', problems)?.length;
 */
export function readArray(value: unknown, at: string, problems: Problems): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    problems.push(`${at} is ${describeValue(value)}; expected an array`);
    return undefined;
  }
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined || !('value' in descriptor)) {
      problems.push(`${at}[${String(index)}] is a hole or an accessor; expected a data item`);
      return undefined;
    }
    items.push(descriptor.value);
  }
  return items;
}

/**
 * Reads a string matching `pattern`.
 *
 * @example
 * readString(value, 'case.case_id', /^[a-z]+$/, problems);
 */
export function readString(value: unknown, at: string, pattern: RegExp, problems: Problems): string | undefined {
  if (typeof value !== 'string' || !pattern.test(value)) {
    problems.push(`${at} is ${describeValue(value)}; expected a string matching ${String(pattern)}`);
    return undefined;
  }
  return value;
}

/**
 * Reads a safe integer of at least `minimum`.
 *
 * @example
 * readInteger(value, 'select.line', 1, problems);
 */
export function readInteger(value: unknown, at: string, minimum: number, problems: Problems): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    problems.push(`${at} is ${describeValue(value)}; expected a safe integer of at least ${String(minimum)}`);
    return undefined;
  }
  return value;
}

/**
 * Reads one of a closed set of strings.
 *
 * @example
 * readChoice(value, 'case.base', BASE_SCENARIO_IDS, problems);
 */
export function readChoice<T extends string>(
  value: unknown,
  at: string,
  choices: readonly T[],
  problems: Problems,
): T | undefined {
  const choice = choices.find((candidate) => candidate === value);
  if (choice === undefined) {
    problems.push(`${at} is ${describeValue(value)}; expected one of ${choices.join(', ')}`);
  }
  return choice;
}

/**
 * Reads a value JSON can represent exactly: no non-finite number, `undefined`, function or
 * non-plain object at any depth (the canonical serializer's own check, iterative).
 *
 * @example
 * readJson(value, 'case.expected', problems);
 */
export function readJson(value: unknown, at: string, problems: Problems): JsonValue | undefined {
  if (canonicalJsonIfRepresentable(value) === undefined) {
    problems.push(`${at} is ${describeValue(value)}; expected a value JSON represents exactly`);
    return undefined;
  }
  return value as JsonValue;
}

/**
 * A bounded description of any value for a problem message.
 *
 * @example
 * describeValue(Number.NaN); // 'number NaN'
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return `number ${String(value)}`;
  }
  const text = canonicalJsonIfRepresentable(value);
  return text === undefined ? `a non-JSON ${typeof value}` : `${jsonKind(value)} ${boundedText(text)}`;
}

function jsonKind(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}
