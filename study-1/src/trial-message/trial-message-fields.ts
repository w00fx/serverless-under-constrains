// Own-property reads over parsed, untrusted JSON objects, shared by the delivered-message and
// registration guards. `JSON.parse` defines `__proto__`, `constructor` or `toString` as own data
// properties, but a plain property read would also find inherited members, so every read goes
// through `Object.hasOwn` (Owner amendment A-05: inherited member names are never fields).

import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedText } from '../record-contract/json-value.ts';
import type { JsonParseFailure } from '../record-contract/parsing.ts';
import type { JsonObject, JsonValue, Uuid4 } from '../record-contract/primitives.ts';
import type { TrialScopedIdentityFields } from '../record-contract/records/group-a/trial_manifest.ts';
import { NONEMPTY_TRIMMED_PATTERN } from '../record-contract/primitives.ts';

/** The two execution identities a trial-scoped record may carry (exactly one of them). */
export const TRIAL_EXECUTION_FIELDS = ['run_id', 'variant_validation_id'] as const;
export type TrialExecutionField = (typeof TRIAL_EXECUTION_FIELDS)[number];

/** A trial-scoped execution identity read from a record: which field, and its value. */
export interface TrialExecutionRef {
  readonly field: TrialExecutionField;
  readonly id: Uuid4;
}

/**
 * The value of an own property, or `undefined` when the object has no such own property.
 *
 * @example
 * ownField(JSON.parse('{"__proto__": 1}'), '__proto__'); // 1
 * ownField({}, 'toString'); // undefined
 */
export function ownField(object: JsonObject, name: string): JsonValue | undefined {
  return Object.hasOwn(object, name) ? object[name] : undefined;
}

/**
 * The first own property name outside `allowed`, or `undefined` when there is none.
 *
 * @example
 * unexpectedField({ a: 1, b: 2 }, new Set(['a'])); // 'b'
 */
export function unexpectedField(object: JsonObject, allowed: ReadonlySet<string>): string | undefined {
  return Object.keys(object).find((name) => !allowed.has(name));
}

/**
 * Whether a value matches `_defs.schema.json#/$defs/nonempty_trimmed`.
 *
 * @example
 * isNonemptyTrimmed('ref-poc-001'); // true
 * isNonemptyTrimmed(' ref'); // false
 */
export function isNonemptyTrimmed(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && NONEMPTY_TRIMMED_PATTERN.test(value);
}

/**
 * The execution identity of a trial-scoped object when exactly one of `run_id` and
 * `variant_validation_id` is an own lowercase UUIDv4 and the other is absent; `undefined`
 * otherwise.
 *
 * @example
 * trialExecutionOf({ run_id: runId }); // { field: 'run_id', id: runId }
 * trialExecutionOf({ run_id: runId, variant_validation_id: validationId }); // undefined
 */
export function trialExecutionOf(object: JsonObject): TrialExecutionRef | undefined {
  const run = ownField(object, 'run_id');
  const validation = ownField(object, 'variant_validation_id');
  if (run !== undefined && validation !== undefined) {
    return undefined;
  }
  if (isUuid4(run)) {
    return { field: 'run_id', id: run };
  }
  return isUuid4(validation) ? { field: 'variant_validation_id', id: validation } : undefined;
}

/**
 * The execution identity of a typed trial-scoped record (a manifest or a registration).
 *
 * @example
 * executionRefOf({ run_id: runId }); // { field: 'run_id', id: runId }
 */
export function executionRefOf(
  record: { readonly run_id: Uuid4 } | { readonly variant_validation_id: Uuid4 },
): TrialExecutionRef {
  return 'run_id' in record
    ? { field: 'run_id', id: record.run_id }
    : { field: 'variant_validation_id', id: record.variant_validation_id };
}

/**
 * The execution identity field of a trial-scoped record, ready to spread into another record.
 *
 * @example
 * executionIdentityOfTrial(manifest); // { run_id } for a run's trial
 */
export function executionIdentityOfTrial(
  record: { readonly run_id: Uuid4 } | { readonly variant_validation_id: Uuid4 },
): TrialScopedIdentityFields {
  const ref = executionRefOf(record);
  return ref.field === 'run_id' ? { run_id: ref.id } : { variant_validation_id: ref.id };
}

/**
 * A parse failure as detail text, bounded: the parser's message for invalid JSON, or the byte
 * offset of invalid UTF-8.
 *
 * @example
 * describeParseFailure({ kind: 'invalid_utf8', byte_offset: 1 }); // 'invalid UTF-8 at byte 1'
 */
export function describeParseFailure(failure: JsonParseFailure): string {
  return failure.kind === 'invalid_json'
    ? boundedText(failure.detail)
    : `invalid UTF-8 at byte ${String(failure.byte_offset)}`;
}
