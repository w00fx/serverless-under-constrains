// Reading the correlation members of a parsed record (BR-RUA-008, BR-RUA-033 envelope): its
// execution identity, manifest digests and trial identity. Records come from untrusted bytes, so
// every read takes own members only (an inherited name such as `constructor` is never a member,
// Owner amendment A-05) and only string values count.

import { isJsonObject } from '../record-contract/json-value.ts';
import type { ExecutionIdentity, JsonObject, JsonValue } from '../record-contract/primitives.ts';

/** The envelope members that correlate a record to its execution and trial (design §8.2 I2). */
export const EXECUTION_ID_FIELDS = ['run_id', 'variant_validation_id', 'transport_probe_id'] as const;
export type ExecutionIdField = (typeof EXECUTION_ID_FIELDS)[number];

/** The partition name of execution-level records (and of every probe record, D-06). */
export const EXECUTION_PARTITION = 'execution';

/** The record types that carry no correlation member: inputs bound by the trial manifest's digests. */
export const DIGEST_BOUND_INPUT_TYPES: ReadonlySet<string | undefined> = new Set(['payment', 'approved_decision']);

/**
 * An own string member of a parsed record, or `undefined`.
 *
 * @example
 * ownString({ trial_id: 't' }, 'trial_id'); // 't'
 * ownString({}, 'constructor'); // undefined (inherited, not own)
 */
export function ownString(value: JsonValue, field: string): string | undefined {
  if (!isJsonObject(value) || !Object.hasOwn(value, field)) {
    return undefined;
  }
  const member = value[field];
  return typeof member === 'string' ? member : undefined;
}

/**
 * The execution identity field of an identity kind.
 *
 * @example
 * executionIdField({ execution_kind: 'RUN', run_id }); // 'run_id'
 */
export function executionIdField(identity: ExecutionIdentity): ExecutionIdField {
  switch (identity.execution_kind) {
    case 'RUN':
      return 'run_id';
    case 'TRANSPORT_PROBE':
      return 'transport_probe_id';
    case 'VARIANT_VALIDATION':
      return 'variant_validation_id';
  }
}

/**
 * The id an execution identity carries.
 *
 * @example
 * executionIdValue({ execution_kind: 'RUN', run_id }); // run_id
 */
export function executionIdValue(identity: ExecutionIdentity): string {
  switch (identity.execution_kind) {
    case 'RUN':
      return identity.run_id;
    case 'TRANSPORT_PROBE':
      return identity.transport_probe_id;
    case 'VARIANT_VALIDATION':
      return identity.variant_validation_id;
  }
}

/**
 * Whether a record names an execution other than the active one: it carries an execution id
 * member that is not the active kind's field with the active id. A record without any execution
 * id member names none (that is missing correlation, not another execution).
 *
 * @example
 * namesOtherExecution({ run_id: 'b' }, { execution_kind: 'RUN', run_id: 'a' }); // true
 */
export function namesOtherExecution(value: JsonValue, active: ExecutionIdentity): boolean {
  return otherExecutionField(value, active) !== undefined;
}

/**
 * The first execution id member that names an execution other than the active one, or
 * `undefined`: what a traceability reason quotes as the offending identity.
 *
 * @example
 * otherExecutionField({ run_id: 'b' }, { execution_kind: 'RUN', run_id: 'a' }); // 'run_id'
 */
export function otherExecutionField(value: JsonValue, active: ExecutionIdentity): ExecutionIdField | undefined {
  const activeField = executionIdField(active);
  return EXECUTION_ID_FIELDS.find((field) => {
    const named = ownString(value, field);
    return named !== undefined && (field !== activeField || named !== executionIdValue(active));
  });
}

/**
 * Whether a record has any execution id member, whatever its value: a member that is present but
 * malformed is a schema fault, not missing correlation.
 *
 * @example
 * hasExecutionId({ transport_probe_id: 'p' }); // true
 * hasExecutionId({ run_id: 7 }); // true
 */
export function hasExecutionId(value: JsonObject): boolean {
  return EXECUTION_ID_FIELDS.some((field) => Object.hasOwn(value, field));
}

/**
 * The record's `trial_id` or `execution` for an execution-level record: the journal partition it
 * belongs to.
 *
 * @example
 * partitionOf({ trial_id: 't' }); // 't'
 * partitionOf({}); // 'execution'
 */
export function partitionOf(value: JsonValue): string {
  return ownString(value, 'trial_id') ?? EXECUTION_PARTITION;
}
