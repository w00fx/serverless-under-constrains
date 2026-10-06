// The `execution_identity` rule of `_defs.schema.json`: a provider payload names exactly one of
// `run_id`, `variant_validation_id` and `transport_probe_id`, as a lowercase UUIDv4 (BR-RUA-033).
// Shared by the refund-call guard and the warm-up guard.

import { isUuid4 } from '../record-contract/identifiers.ts';
import type { ExecutionIdentity, JsonObject, Result, Uuid4 } from '../record-contract/primitives.ts';
import { describeUntrusted } from './untrusted-json.ts';

/** The envelope field of each execution kind. */
export const EXECUTION_IDENTITY_FIELDS = [
  ['run_id', 'RUN'],
  ['variant_validation_id', 'VARIANT_VALIDATION'],
  ['transport_probe_id', 'TRANSPORT_PROBE'],
] as const;

/**
 * Reads the single execution identity of a payload object.
 *
 * @example
 * parseExecutionIdentityFields({ run_id: '…' }); // { ok: true, value: { execution_kind: 'RUN', run_id: '…' } }
 * parseExecutionIdentityFields({}); // { ok: false, error: 'execution identity fields []; expected exactly one of …' }
 */
export function parseExecutionIdentityFields(payload: JsonObject): Result<ExecutionIdentity, string> {
  const present = EXECUTION_IDENTITY_FIELDS.filter(([field]) => Object.hasOwn(payload, field));
  const [only, ...others] = present;
  if (only === undefined || others.length > 0) {
    const names = present.map(([field]) => field).join(', ');
    return {
      ok: false,
      error: `execution identity fields [${names}]; expected exactly one of run_id, variant_validation_id, transport_probe_id`,
    };
  }
  const [field, kind] = only;
  const id = payload[field];
  if (!isUuid4(id)) {
    return { ok: false, error: `${field} is ${describeUntrusted(id)}; expected a lowercase RFC 4122 version-4 UUID` };
  }
  return { ok: true, value: executionIdentityOf(kind, id) };
}

/**
 * Whether two execution identities name the same execution.
 *
 * @example
 * sameExecution({ execution_kind: 'RUN', run_id: a }, { execution_kind: 'RUN', run_id: a }); // true
 */
export function sameExecution(a: ExecutionIdentity, b: ExecutionIdentity): boolean {
  return a.execution_kind === b.execution_kind && executionIdValue(a) === executionIdValue(b);
}

/**
 * Describes an execution for an error message.
 *
 * @example
 * describeExecution({ execution_kind: 'RUN', run_id }); // 'RUN <run_id>'
 */
export function describeExecution(execution: ExecutionIdentity): string {
  return `${execution.execution_kind} ${executionIdValue(execution)}`;
}

function executionIdValue(execution: ExecutionIdentity): Uuid4 {
  switch (execution.execution_kind) {
    case 'RUN':
      return execution.run_id;
    case 'VARIANT_VALIDATION':
      return execution.variant_validation_id;
    case 'TRANSPORT_PROBE':
      return execution.transport_probe_id;
  }
}

/**
 * Builds the execution identity of a kind and an id.
 *
 * @example
 * executionIdentityOf('TRANSPORT_PROBE', id); // { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id }
 */
export function executionIdentityOf(kind: ExecutionIdentity['execution_kind'], id: Uuid4): ExecutionIdentity {
  switch (kind) {
    case 'RUN':
      return { execution_kind: 'RUN', run_id: id };
    case 'VARIANT_VALIDATION':
      return { execution_kind: 'VARIANT_VALIDATION', variant_validation_id: id };
    case 'TRANSPORT_PROBE':
      return { execution_kind: 'TRANSPORT_PROBE', transport_probe_id: id };
  }
}
